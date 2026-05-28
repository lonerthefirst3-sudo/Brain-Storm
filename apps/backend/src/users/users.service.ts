import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User } from './user.entity';
import { ImportJob, ImportJobStatus, ImportJobType } from '../import-export/import-job.entity';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User) private repo: Repository<User>,
    @InjectRepository(ImportJob) private importJobRepo: Repository<ImportJob>,
  ) {}

  findByEmail(email: string) {
    return this.repo.findOne({ where: { email } });
  }

  findByVerificationToken(hash: string) {
    return this.repo.findOne({ where: { verificationToken: hash } });
  }

  findById(id: string) {
    return this.repo.findOne({ where: { id } });
  }

  findByStellarPublicKey(stellarPublicKey: string) {
    return this.repo.findOne({ where: { stellarPublicKey } });
  }

  create(data: Partial<User>) {
    return this.repo.save(this.repo.create(data));
  }

  async update(id: string, data: Partial<User>) {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException('User not found');
    return this.repo.save({ ...user, ...data });
  }

  async findAll(
    options: {
      page?: number;
      limit?: number;
      role?: string;
      isVerified?: boolean;
      search?: string;
    } = {}
  ) {
    const { page = 1, limit = 10, role, isVerified, search } = options;

    const query = this.repo.createQueryBuilder('user');

    if (role) {
      query.andWhere('user.role = :role', { role });
    }

    if (isVerified !== undefined) {
      query.andWhere('user.isVerified = :isVerified', { isVerified });
    }

    if (search) {
      query.andWhere('user.email ILIKE :search', { search: `%${search}%` });
    }

    query.andWhere('user.deletedAt IS NULL');

    const [users, total] = await query
      .skip((page - 1) * limit)
      .take(limit)
      .orderBy('user.createdAt', 'DESC')
      .getManyAndCount();

    return {
      data: users,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async banUser(id: string, isBanned: boolean) {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException('User not found');
    return this.repo.save({ ...user, isBanned });
  }

  async changeRole(id: string, role: string) {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException('User not found');
    return this.repo.save({ ...user, role });
  }

  async softDelete(id: string) {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException('User not found');
    return this.repo.save({ ...user, deletedAt: new Date() });
  }

  findByReferralCode(code: string) {
    return this.repo.findOne({ where: { referralCode: code } });
  }

  async getReferralStats(userId: string) {
    const count = await this.repo.count({ where: { referredBy: userId } });
    return { referralCount: count, earnedBst: count * 50 };
  }

  async findImportJob(jobId: string): Promise<ImportJob> {
    const job = await this.importJobRepo.findOne({ where: { id: jobId } });
    if (!job) {
      throw new NotFoundException('Import job not found');
    }
    return job;
  }

  async bulkImportUsersCsv(buffer: Buffer, adminId: string): Promise<ImportJob> {
    const rows = this.parseCsv(buffer);
    const job = await this.importJobRepo.save(
      this.importJobRepo.create({
        instructorId: adminId,
        type: ImportJobType.USER,
        status: ImportJobStatus.PENDING,
        total: rows.length,
        processed: 0,
        result: {},
      }),
    );

    this.processUserImportJob(job.id, rows).catch((err) => {
      this.logger.error(`Bulk user import job failed: ${err?.message ?? err}`);
    });

    return job;
  }

  private async processUserImportJob(jobId: string, rows: Record<string, string>[]) {
    await this.importJobRepo.update(jobId, { status: ImportJobStatus.PROCESSING });
    const results: Record<string, unknown> = {};
    let processed = 0;

    for (const row of rows) {
      try {
        await this.createUserFromCsvRow(row);
        results[row.email || `row-${processed + 1}`] = { success: true };
      } catch (err: unknown) {
        results[row.email || `row-${processed + 1}`] = {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      processed += 1;
      await this.importJobRepo.update(jobId, { processed, result: results });
    }

    await this.importJobRepo.update(jobId, {
      status: ImportJobStatus.DONE,
      result: results,
    });
  }

  private parseCsv(buffer: Buffer): Record<string, string>[] {
    const text = buffer.toString('utf-8').trim();
    if (!text) return [];

    const [headerLine, ...lines] = text.split(/\r?\n/);
    const headers = headerLine.split(',').map((value) => value.trim());

    return lines.filter(Boolean).map((line) => {
      const cols = line.split(',').map((value) => value.trim());
      const row: Record<string, string> = {};
      headers.forEach((header, index) => {
        row[header] = cols[index] ?? '';
      });
      return row;
    });
  }

  private async createUserFromCsvRow(row: Record<string, string>) {
    const email = (row.email || '').trim();
    if (!email) {
      throw new Error('Each row must contain an email');
    }

    const existing = await this.findByEmail(email);
    if (existing) {
      throw new Error(`User already exists: ${email}`);
    }

    const passwordHash = await bcrypt.hash(Math.random().toString(36).slice(2), 10);
    const user = this.repo.create({
      email,
      username: row.username?.trim() || undefined,
      role: row.role?.trim() || 'student',
      isVerified: row.isVerified?.trim().toLowerCase() === 'true',
      referralCode: row.referralCode?.trim() || undefined,
      passwordHash,
    });

    await this.repo.save(user);
  }
}

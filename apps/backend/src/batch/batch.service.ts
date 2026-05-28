import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { BatchJob, BatchJobType } from './batch-job.entity';

@Injectable()
export class BatchService {
  constructor(
    @InjectRepository(BatchJob) private readonly jobRepo: Repository<BatchJob>,
    @InjectQueue('batch') private readonly batchQueue: Queue,
  ) {}

  private async createBatchJob(
    type: BatchJobType,
    payload: Record<string, any>[],
    createdById: string,
  ): Promise<BatchJob> {
    const job = this.jobRepo.create({
      type,
      payload,
      totalItems: payload.length,
      processedItems: 0,
      failedItems: 0,
      createdById,
    });

    const savedJob = await this.jobRepo.save(job);

    await this.batchQueue.add(
      type,
      { jobId: savedJob.id, payload, totalItems: payload.length },
      { jobId: savedJob.id },
    );

    return savedJob;
  }

  async createUserBatch(payload: Record<string, any>[], createdById: string): Promise<BatchJob> {
    return this.createBatchJob('users', payload, createdById);
  }

  async createCourseBatch(payload: Record<string, any>[], createdById: string): Promise<BatchJob> {
    return this.createBatchJob('courses', payload, createdById);
  }

  async createCertificateBatch(payload: Record<string, any>[], createdById: string): Promise<BatchJob> {
    return this.createBatchJob('certificates', payload, createdById);
  }

  async createEmailBatch(payload: Record<string, any>[], createdById: string): Promise<BatchJob> {
    return this.createBatchJob('emails', payload, createdById);
  }

  async createExportBatch(payload: Record<string, any>[], createdById: string): Promise<BatchJob> {
    return this.createBatchJob('export', payload, createdById);
  }

  async listJobs(type?: string) {
    const qb = this.jobRepo.createQueryBuilder('job');
    if (type) qb.where('job.type = :type', { type });
    return qb.orderBy('job.createdAt', 'DESC').getMany();
  }

  async getJobStatus(jobId: string) {
    const job = await this.jobRepo.findOne({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Batch job not found');
    return job;
  }
}

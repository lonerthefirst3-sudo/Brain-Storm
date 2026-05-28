import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { KycCustomer, KycStatus } from './kyc-customer.entity';
import { KycDocument } from './kyc-document.entity';

@Injectable()
export class KycService {
  private readonly logger = new Logger(KycService.name);
  private readonly apiKey: string;

  constructor(
    @InjectRepository(KycCustomer) private repo: Repository<KycCustomer>,
    @InjectRepository(KycDocument) private documentRepo: Repository<KycDocument>,
    private configService: ConfigService
  ) {
    this.apiKey = this.configService.get<string>('kyc.providerApiKey') ?? '';
  }

  async getStatus(stellarPublicKey: string): Promise<KycCustomer> {
    const customer = await this.repo.findOne({ where: { stellarPublicKey } });
    if (!customer) {
      // Return a virtual record — no DB row yet
      return Object.assign(new KycCustomer(), { stellarPublicKey, status: 'none' as KycStatus });
    }
    return customer;
  }

  async upsertCustomer(
    stellarPublicKey: string,
    fields: Record<string, string>
  ): Promise<KycCustomer> {
    let customer = await this.repo.findOne({ where: { stellarPublicKey } });

    if (!customer) {
      customer = this.repo.create({ stellarPublicKey, status: 'pending' });
    } else {
      customer.status = 'pending';
    }

    // Submit to KYC provider
    if (this.apiKey) {
      try {
        const res = await fetch('https://api.synaps.io/v4/individual/session', {
          method: 'POST',
          headers: {
            'Client-Id': this.apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ alias: stellarPublicKey, ...fields }),
        });
        if (res.ok) {
          const data = await res.json();
          customer.providerId = data.session_id ?? data.id ?? null;
        } else {
          this.logger.warn(`KYC provider returned ${res.status} for ${stellarPublicKey}`);
        }
      } catch (err) {
        this.logger.error(`KYC provider request failed: ${err.message}`);
      }
    }

    return this.repo.save(customer);
  }

  async uploadDocument(
    stellarPublicKey: string,
    file: Express.Multer.File
  ): Promise<{ documentId: string; status: KycStatus }> {
    const customer = await this.repo.findOne({ where: { stellarPublicKey } });
    if (!customer) {
      throw new Error(`Customer record not found for ${stellarPublicKey}`);
    }

    const document = this.documentRepo.create({
      stellarPublicKey,
      filename: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      providerReference: null,
      metadata: { uploadDate: new Date().toISOString() },
    });

    if (this.apiKey) {
      try {
        const response = await fetch('https://api.synaps.io/v4/individual/document', {
          method: 'POST',
          headers: {
            'Client-Id': this.apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            alias: stellarPublicKey,
            filename: file.originalname,
            contentBase64: file.buffer.toString('base64'),
            mimeType: file.mimetype,
          }),
        });
        if (response.ok) {
          const payload = await response.json();
          document.providerReference = payload.document_id ?? payload.id ?? null;
        } else {
          this.logger.warn(`KYC document upload failed with ${response.status}`);
        }
      } catch (err) {
        this.logger.error(`KYC document upload failed: ${err.message}`);
      }
    }

    const savedDocument = await this.documentRepo.save(document);
    customer.status = 'pending';
    await this.repo.save(customer);

    return { documentId: savedDocument.id, status: customer.status };
  }

  async getComplianceReport() {
    const results = await this.repo
      .createQueryBuilder('customer')
      .select('customer.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('customer.status')
      .getRawMany();

    return results.reduce((acc, row) => {
      acc[row.status] = Number(row.count);
      return acc;
    }, {} as Record<string, number>);
  }

  /** Called by the webhook endpoint when the provider sends a status update */
  async handleWebhook(payload: {
    alias?: string;
    session_id?: string;
    status: string;
  }): Promise<void> {
    const where = payload.alias
      ? { stellarPublicKey: payload.alias }
      : { providerId: payload.session_id };

    const customer = await this.repo.findOne({ where: where as any });
    if (!customer) {
      this.logger.warn(`Webhook received for unknown customer: ${JSON.stringify(where)}`);
      return;
    }

    const statusMap: Record<string, KycStatus> = {
      APPROVED: 'approved',
      VERIFIED: 'approved',
      REJECTED: 'rejected',
      DECLINED: 'rejected',
      PENDING: 'pending',
    };

    customer.status = statusMap[payload.status?.toUpperCase()] ?? 'pending';
    await this.repo.save(customer);
    this.logger.log(`KYC status updated: ${customer.stellarPublicKey} → ${customer.status}`);
  }

  async isApproved(stellarPublicKey: string): Promise<boolean> {
    const customer = await this.repo.findOne({ where: { stellarPublicKey } });
    return customer?.status === 'approved';
  }
}

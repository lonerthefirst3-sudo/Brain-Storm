import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('kyc_documents')
export class KycDocument {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  stellarPublicKey: string;

  @Column()
  filename: string;

  @Column()
  mimetype: string;

  @Column({ nullable: true })
  providerReference: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @Column({ default: 0 })
  size: number;

  @CreateDateColumn()
  createdAt: Date;
}

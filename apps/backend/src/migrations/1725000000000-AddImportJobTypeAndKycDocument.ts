import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddImportJobTypeAndKycDocument1725000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "import_jobs_type_enum" AS ENUM ('course', 'user')`);
    await queryRunner.query(`ALTER TABLE "import_jobs" ADD "type" "import_jobs_type_enum" NOT NULL DEFAULT 'course'`);

    await queryRunner.query(`CREATE TABLE "kyc_documents" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "stellarPublicKey" character varying NOT NULL,
      "filename" character varying NOT NULL,
      "mimetype" character varying NOT NULL,
      "providerReference" character varying,
      "metadata" jsonb,
      "size" integer NOT NULL DEFAULT 0,
      "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
      CONSTRAINT "PK_kyc_documents_id" PRIMARY KEY ("id")
    )`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "kyc_documents"');
    await queryRunner.query('ALTER TABLE "import_jobs" DROP COLUMN "type"');
    await queryRunner.query('DROP TYPE "import_jobs_type_enum"');
  }
}

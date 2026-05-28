import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiConsumes } from '@nestjs/swagger';
import { KycService } from './kyc.service';

@ApiTags('kyc')
@Controller('kyc')
export class KycController {
  constructor(private kycService: KycService) {}

  @Get('status/:stellarPublicKey')
  @ApiOperation({ summary: 'SEP-0012: get KYC status for a Stellar account' })
  @ApiResponse({ status: 200, description: 'Returns KYC status record' })
  getStatus(@Param('stellarPublicKey') stellarPublicKey: string) {
    return this.kycService.getStatus(stellarPublicKey);
  }

  @Put('customer')
  @ApiOperation({ summary: 'SEP-0012: submit or update KYC fields' })
  @ApiResponse({ status: 200, description: 'KYC submission accepted' })
  upsertCustomer(@Body() body: { stellarPublicKey: string; [key: string]: string }) {
    const { stellarPublicKey, ...fields } = body;
    return this.kycService.upsertCustomer(stellarPublicKey, fields);
  }

  @Post('customer/document')
  @ApiOperation({ summary: 'Upload a KYC document for a customer' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        stellarPublicKey: { type: 'string' },
        document: { type: 'string', format: 'binary' },
      },
      required: ['stellarPublicKey', 'document'],
    },
  })
  @UseInterceptors(FileInterceptor('document', { limits: { fileSize: 15 * 1024 * 1024 } }))
  uploadDocument(
    @Body('stellarPublicKey') stellarPublicKey: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.kycService.uploadDocument(stellarPublicKey, file);
  }

  @Get('report')
  @ApiOperation({ summary: 'Get compliance report for KYC statuses' })
  @ApiResponse({ status: 200, description: 'Returns summary counts for KYC status values' })
  getComplianceReport() {
    return this.kycService.getComplianceReport();
  }

  /** Webhook called by the KYC provider when verification status changes */
  @Post('webhook')
  @ApiOperation({ summary: 'KYC provider webhook — status update callback' })
  async webhook(@Body() payload: any) {
    await this.kycService.handleWebhook(payload);
    return { received: true };
  }
}

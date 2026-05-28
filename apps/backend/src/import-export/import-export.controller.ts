import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
  Request,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { ImportExportService } from './import-export.service';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

@ApiTags('import-export')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('instructor', 'admin')
@Controller('courses')
export class ImportExportController {
  constructor(private readonly service: ImportExportService) {}

  @Get(':id/export')
  @ApiOperation({ summary: 'Export a course as JSON or CSV' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Output format for export' })
  async exportCourse(
    @Param('id') id: string,
    @Query('format') format: string = 'json',
    @Res() res: Response,
  ) {
    const normalized = (format || 'json').toLowerCase();

    if (normalized === 'csv') {
      const csv = await this.service.exportCourseCsv(id);
      res
        .setHeader('Content-Type', 'text/csv')
        .setHeader('Content-Disposition', `attachment; filename="course-${id}.csv"`)
        .send(csv);
      return;
    }

    const data = await this.service.exportCourse(id);
    res
      .setHeader('Content-Type', 'application/json')
      .setHeader('Content-Disposition', `attachment; filename="course-${id}.json"`)
      .send(JSON.stringify(data, null, 2));
  }

  @Post('import/json')
  @ApiOperation({ summary: 'Import a course from JSON file' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_SIZE } }))
  importJson(
    @UploadedFile() file: Express.Multer.File,
    @Request() req: { user: { id: string } }
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    return this.service.importJson(file.buffer, req.user.id);
  }

  @Post('import/scorm')
  @ApiOperation({ summary: 'Import a course from SCORM 1.2 or 2004 ZIP package' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_SIZE } }))
  importScorm(
    @UploadedFile() file: Express.Multer.File,
    @Request() req: { user: { id: string } }
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    return this.service.importScorm(file.buffer, req.user.id);
  }

  @Post('import/bulk')
  @ApiOperation({ summary: 'Bulk import multiple courses (JSON or SCORM ZIP). Returns a job ID for progress tracking.' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string', format: 'binary' } } } } })
  @UseInterceptors(FilesInterceptor('files', 20, { limits: { fileSize: MAX_FILE_SIZE } }))
  bulkImport(
    @UploadedFiles() files: Express.Multer.File[],
    @Request() req: { user: { id: string } }
  ) {
    if (!files?.length) throw new BadRequestException('No files uploaded');
    const buffers = files.map((f) => ({ name: f.originalname, data: f.buffer }));
    return this.service.startBulkImport(buffers, req.user.id);
  }

  @Get('import/jobs/:jobId')
  @ApiOperation({ summary: 'Get progress/status of a bulk import job' })
  getJobStatus(@Param('jobId') jobId: string) {
    return this.service.getJobStatus(jobId);
  }
}

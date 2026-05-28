import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as AdmZip from 'adm-zip';
import { parseStringPromise } from 'xml2js';
import { Course } from '../courses/course.entity';
import { CourseModule } from '../courses/course-module.entity';
import { Lesson } from '../courses/lesson.entity';
import { ImportJob, ImportJobStatus } from './import-job.entity';
import { CourseJsonExport, CourseJsonModule } from './import-export.types';

@Injectable()
export class ImportExportService {
  private readonly logger = new Logger(ImportExportService.name);

  constructor(
    @InjectRepository(Course) private readonly courseRepo: Repository<Course>,
    @InjectRepository(CourseModule) private readonly moduleRepo: Repository<CourseModule>,
    @InjectRepository(Lesson) private readonly lessonRepo: Repository<Lesson>,
    @InjectRepository(ImportJob) private readonly jobRepo: Repository<ImportJob>
  ) {}

  // ─── Export ────────────────────────────────────────────────────────────────

  async exportCourse(courseId: string): Promise<CourseJsonExport> {
    const course = await this.courseRepo.findOne({
      where: { id: courseId, isDeleted: false },
      relations: ['modules', 'modules.lessons'],
    });
    if (!course) throw new NotFoundException('Course not found');

    return {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      course: {
        title: course.title,
        description: course.description,
        level: course.level,
        durationHours: course.durationHours,
        requiresKyc: course.requiresKyc,
        modules: (course.modules ?? [])
          .sort((a, b) => a.order - b.order)
          .map((m) => ({
            title: m.title,
            order: m.order,
            lessons: (m.lessons ?? [])
              .sort((a, b) => a.order - b.order)
              .map((l) => ({
                title: l.title,
                content: l.content,
                videoUrl: l.videoUrl ?? undefined,
                order: l.order,
                durationMinutes: l.durationMinutes,
              })),
          })),
      },
    };
  }

  async exportCourseCsv(courseId: string): Promise<string> {
    const exportData = await this.exportCourse(courseId);
    const headers = [
      'courseTitle',
      'courseDescription',
      'courseLevel',
      'requiresKyc',
      'moduleTitle',
      'moduleOrder',
      'lessonOrder',
      'lessonTitle',
      'lessonDurationMinutes',
      'lessonVideoUrl',
    ];

    const rows = exportData.course.modules.flatMap((module) =>
      module.lessons.map((lesson) => [
        exportData.course.title,
        exportData.course.description,
        exportData.course.level,
        String(exportData.course.requiresKyc),
        module.title,
        String(module.order),
        String(lesson.order),
        lesson.title,
        String(lesson.durationMinutes),
        lesson.videoUrl ?? '',
      ]),
    );

    const escapeValue = (value: string) =>
      `"${String(value).replace(/"/g, '""')}"`;

    return [headers.map(escapeValue).join(','), ...rows.map((row) => row.map(escapeValue).join(','))].join('\n');
  }

  // ─── JSON Import ───────────────────────────────────────────────────────────

  async importJson(
    buffer: Buffer,
    instructorId: string
  ): Promise<{ courseId: string }> {
    let payload: CourseJsonExport;
    try {
      payload = JSON.parse(buffer.toString('utf-8'));
    } catch {
      throw new BadRequestException('Invalid JSON file');
    }
    this.validateJsonPayload(payload);
    const courseId = await this.persistCourse(payload.course, instructorId);
    return { courseId };
  }

  // ─── SCORM Import ──────────────────────────────────────────────────────────

  async importScorm(
    buffer: Buffer,
    instructorId: string
  ): Promise<{ courseId: string }> {
    let zip: AdmZip;
    try {
      zip = new AdmZip(buffer);
    } catch {
      throw new BadRequestException('Invalid ZIP/SCORM package');
    }

    const manifestEntry =
      zip.getEntry('imsmanifest.xml') ??
      zip.getEntries().find((e) => e.entryName.endsWith('imsmanifest.xml'));

    if (!manifestEntry) throw new BadRequestException('imsmanifest.xml not found in package');

    const xml = manifestEntry.getData().toString('utf-8');
    const manifest = await parseStringPromise(xml, { explicitArray: false });

    const courseData = this.parseScormManifest(manifest, zip);
    this.validateJsonPayload(courseData);
    const courseId = await this.persistCourse(courseData.course, instructorId);
    return { courseId };
  }

  // ─── Bulk Migration ────────────────────────────────────────────────────────

  async startBulkImport(
    buffers: { name: string; data: Buffer }[],
    instructorId: string
  ): Promise<ImportJob> {
    const job = await this.jobRepo.save(
      this.jobRepo.create({
        instructorId,
        status: ImportJobStatus.PENDING,
        total: buffers.length,
        processed: 0,
      })
    );

    // Run async without awaiting — progress tracked via job entity
    this.processBulk(job.id, buffers, instructorId).catch((err) =>
      this.logger.error(`Bulk import job ${job.id} failed: ${err}`)
    );

    return job;
  }

  async getJobStatus(jobId: string): Promise<ImportJob> {
    const job = await this.jobRepo.findOne({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Import job not found');
    return job;
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private async processBulk(
    jobId: string,
    buffers: { name: string; data: Buffer }[],
    instructorId: string
  ) {
    await this.jobRepo.update(jobId, { status: ImportJobStatus.PROCESSING });
    const results: Record<string, unknown> = {};
    let processed = 0;

    for (const { name, data } of buffers) {
      try {
        const isScorm = name.endsWith('.zip');
        const res = isScorm
          ? await this.importScorm(data, instructorId)
          : await this.importJson(data, instructorId);
        results[name] = { success: true, courseId: res.courseId };
      } catch (err: unknown) {
        results[name] = { success: false, error: err instanceof Error ? err.message : String(err) };
      }
      processed++;
      await this.jobRepo.update(jobId, { processed });
    }

    // Use query builder to set jsonb result — TypeORM update() doesn't handle jsonb well
    await this.jobRepo
      .createQueryBuilder()
      .update(ImportJob)
      .set({ status: ImportJobStatus.DONE, result: () => `:result` })
      .where('id = :id', { id: jobId })
      .setParameter('result', JSON.stringify(results))
      .execute();
  }

  private async persistCourse(
    data: CourseJsonExport['course'],
    instructorId: string
  ): Promise<string> {
    const course = await this.courseRepo.save(
      this.courseRepo.create({
        title: data.title,
        description: data.description,
        level: data.level,
        durationHours: data.durationHours,
        requiresKyc: data.requiresKyc ?? false,
        instructorId,
        isPublished: false,
      })
    );

    for (const mod of data.modules ?? []) {
      const savedModule = await this.moduleRepo.save(
        this.moduleRepo.create({ courseId: course.id, title: mod.title, order: mod.order })
      );
      for (const lesson of mod.lessons ?? []) {
        await this.lessonRepo.save(
          this.lessonRepo.create({
            moduleId: savedModule.id,
            title: lesson.title,
            content: lesson.content,
            videoUrl: lesson.videoUrl ?? undefined,
            order: lesson.order,
            durationMinutes: lesson.durationMinutes,
          })
        );
      }
    }

    return course.id;
  }

  private validateJsonPayload(payload: unknown): asserts payload is CourseJsonExport {
    const p = payload as CourseJsonExport;
    if (!p?.course?.title) throw new BadRequestException('Missing required field: course.title');
    if (!p.course.description) throw new BadRequestException('Missing required field: course.description');
    if (!Array.isArray(p.course.modules)) throw new BadRequestException('course.modules must be an array');
    for (const mod of p.course.modules) {
      if (!mod.title) throw new BadRequestException('Each module must have a title');
      if (!Array.isArray(mod.lessons)) throw new BadRequestException('Each module must have a lessons array');
      for (const lesson of mod.lessons) {
        if (!lesson.title) throw new BadRequestException('Each lesson must have a title');
        if (lesson.content === undefined) throw new BadRequestException('Each lesson must have content');
      }
    }
  }

  private parseScormManifest(manifest: Record<string, unknown>, zip: AdmZip): CourseJsonExport {
    // Support SCORM 1.2 and 2004 — both use imsmanifest.xml with <manifest> root
    const root = manifest['manifest'] as Record<string, unknown>;
    const metadata = root?.['metadata'] as Record<string, unknown> | undefined;
    const organizations = root?.['organizations'] as Record<string, unknown> | undefined;
    const resources = root?.['resources'] as Record<string, unknown> | undefined;

    const title =
      (metadata?.['schema'] as string) ??
      this.extractScormTitle(organizations) ??
      'Imported SCORM Course';

    const orgList = organizations?.['organization'];
    const org = Array.isArray(orgList) ? orgList[0] : orgList ?? {};
    const orgTitle = (org as Record<string, unknown>)?.['title'] as string | undefined;

    const items = (org as Record<string, unknown>)?.['item'];
    const itemList: Record<string, unknown>[] = Array.isArray(items)
      ? items
      : items
      ? [items as Record<string, unknown>]
      : [];

    const resourceMap = this.buildResourceMap(resources, zip);

    const modules: CourseJsonModule[] = itemList.map((item, idx) => {
      const itemTitle = (item['title'] as string) ?? `Module ${idx + 1}`;
      const subItems = item['item'];
      const subList: Record<string, unknown>[] = Array.isArray(subItems)
        ? subItems
        : subItems
        ? [subItems as Record<string, unknown>]
        : [];

      const lessons = subList.length
        ? subList.map((sub, li) => ({
            title: (sub['title'] as string) ?? `Lesson ${li + 1}`,
            content: resourceMap[(sub['$'] as Record<string, string>)?.identifierref ?? ''] ?? '',
            order: li,
            durationMinutes: 0,
          }))
        : [
            {
              title: itemTitle,
              content: resourceMap[(item['$'] as Record<string, string>)?.identifierref ?? ''] ?? '',
              order: 0,
              durationMinutes: 0,
            },
          ];

      return { title: itemTitle, order: idx, lessons };
    });

    return {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      course: {
        title: orgTitle ?? title,
        description: `Imported from SCORM package`,
        level: 'beginner',
        durationHours: 0,
        requiresKyc: false,
        modules,
      },
    };
  }

  private extractScormTitle(organizations: Record<string, unknown> | undefined): string | undefined {
    const org = organizations?.['organization'];
    const first = Array.isArray(org) ? org[0] : org;
    return (first as Record<string, unknown>)?.['title'] as string | undefined;
  }

  private buildResourceMap(
    resources: Record<string, unknown> | undefined,
    zip: AdmZip
  ): Record<string, string> {
    const map: Record<string, string> = {};
    if (!resources) return map;
    const resList = resources['resource'];
    const list: Record<string, unknown>[] = Array.isArray(resList)
      ? resList
      : resList
      ? [resList as Record<string, unknown>]
      : [];

    for (const res of list) {
      const attrs = res['$'] as Record<string, string> | undefined;
      const id = attrs?.['identifier'];
      const href = attrs?.['href'];
      if (!id || !href) continue;
      const entry = zip.getEntry(href) ?? zip.getEntries().find((e) => e.entryName.endsWith(href));
      if (entry) {
        map[id] = entry.getData().toString('utf-8');
      }
    }
    return map;
  }
}

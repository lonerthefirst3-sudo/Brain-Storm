import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cache } from 'cache-manager';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject } from '@nestjs/common';
import { Course, CourseStatus } from './course.entity';
import { CourseQueryDto } from './dto/course-query.dto';
import { SearchService } from '../search/search.service';

@Injectable()
export class CoursesService {
  private readonly CACHE_KEY = 'courses:all';
  private readonly COURSE_CACHE_KEY_PREFIX = 'courses:';
  private readonly CACHE_TTL = 60;

  constructor(
    @InjectRepository(Course) private repo: Repository<Course>,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private readonly searchService: SearchService
  ) {}

  async findAll(query: CourseQueryDto = {}) {
    const { search, level, page = 1, limit = 20 } = query;
    const cacheKey = `${this.CACHE_KEY}:${search ?? 'all'}:${level ?? 'all'}:${page}:${limit}`;

    return this.cacheManager.wrap(cacheKey, async () => this.queryCourses(query), {
      ttl: this.CACHE_TTL,
    });
  }

  private async queryCourses(query: CourseQueryDto = {}) {
    const { search, level, page = 1, limit = 20 } = query;

    const qb = this.repo
      .createQueryBuilder('course')
      .where('course.isPublished = :isPublished', { isPublished: true })
      .andWhere('course.isDeleted = :isDeleted', { isDeleted: false });

    if (search) {
      qb.andWhere('(course.title ILIKE :search OR course.description ILIKE :search)', {
        search: `%${search}%`,
      });
    }

    if (level) {
      qb.andWhere('course.level = :level', { level });
    }

    const total = await qb.clone().getCount();
    const offset = (page - 1) * limit;

    const { raw, entities } = await qb
      .leftJoin('course.reviews', 'review')
      .addSelect('COALESCE(AVG(review.rating), 0)', 'course_averageRating')
      .skip(offset)
      .take(limit)
      .orderBy('course.createdAt', 'DESC')
      .groupBy('course.id')
      .getRawAndEntities();

    const averageRatings = new Map(
      raw.map((item, index) => [entities[index].id, Number(item.course_averageRating) || 0])
    );

    const data = entities.map((course) => ({
      ...course,
      averageRating: averageRatings.get(course.id) ?? 0,
    }));

    return { data, total, page, limit };
  }

  async findOne(id: string): Promise<Course> {
    const cacheKey = `${this.COURSE_CACHE_KEY_PREFIX}${id}`;
    return this.cacheManager.wrap(cacheKey, async () => {
      const course = await this.repo.findOne({ where: { id, isDeleted: false } });
      if (!course) throw new NotFoundException('Course not found');
      return course;
    }, { ttl: this.CACHE_TTL });
  }

  async create(data: Partial<Course>) {
    const course = await this.repo.save(this.repo.create(data));
    await this.invalidateCache();
    await this.searchService.indexCourse(course).catch(() => {});
    return course;
  }

  async update(id: string, data: Partial<Course>) {
    const course = await this.findOne(id);
    if (!course) throw new NotFoundException('Course not found');
    const updated = await this.repo.save({ ...course, ...data });
    await this.invalidateCache(id);
    await this.searchService.indexCourse(updated).catch(() => {});
    return updated;
  }

  async delete(id: string) {
    const course = await this.findOne(id);
    if (!course) throw new NotFoundException('Course not found');
    const removed = await this.repo.remove(course);
    await this.invalidateCache(id);
    await this.searchService.deleteFromIndex('courses', id).catch(() => {});
    return removed;
  }

  private async invalidateCache(id?: string) {
    await this.deleteCacheKeys(`${this.CACHE_KEY}:*`);
    if (id) {
      await this.cacheManager.del(`${this.COURSE_CACHE_KEY_PREFIX}${id}`);
    }
  }

  private async deleteCacheKeys(pattern: string) {
    const store: any = (this.cacheManager as any).store;
    const client = store?.getClient?.();

    if (!client || typeof client.keys !== 'function') {
      await this.cacheManager.reset();
      return;
    }

    const keys: string[] = await client.keys(pattern);
    if (keys.length) {
      await client.del(...keys);
    }
  }

  async warmCache() {
    await this.findAll({});
  }

  async scheduleCourse(id: string, scheduledAt: Date): Promise<Course> {
    if (scheduledAt <= new Date()) {
      throw new BadRequestException('scheduledAt must be in the future');
    }
    const course = await this.findOne(id);
    return this.repo.save({
      ...course,
      status: CourseStatus.SCHEDULED,
      scheduledAt,
      isPublished: false,
    });
  }

  async publishNow(id: string): Promise<Course> {
    const course = await this.findOne(id);
    const now = new Date();
    return this.repo.save({
      ...course,
      status: CourseStatus.PUBLISHED,
      isPublished: true,
      publishedAt: now,
      scheduledAt: course.scheduledAt ?? null,
    });
  }
}

import { Module } from '@nestjs/common';
import { CacheManagementController } from './cache-management.controller';
import { CacheManagementService } from './cache-management.service';
import { CoursesModule } from '../courses/courses.module';

@Module({
  imports: [CoursesModule],
  providers: [CacheManagementService],
  controllers: [CacheManagementController],
})
export class CacheManagementModule {}

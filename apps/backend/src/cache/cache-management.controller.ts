import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CacheManagementService } from './cache-management.service';

@ApiTags('cache')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@Controller('cache')
export class CacheManagementController {
  constructor(private readonly cacheService: CacheManagementService) {}

  @Get('stats')
  @ApiOperation({ summary: 'Get Redis cache statistics and availability info' })
  @ApiResponse({ status: 200, description: 'Cache statistics returned' })
  stats() {
    return this.cacheService.getStats();
  }

  @Post('clear')
  @ApiOperation({ summary: 'Clear all cache entries' })
  @ApiResponse({ status: 200, description: 'Cache cleared successfully' })
  clear() {
    return this.cacheService.clear();
  }

  @Post('warm')
  @ApiOperation({ summary: 'Warm cache for frequently accessed data' })
  @ApiResponse({ status: 200, description: 'Cache warm-up started' })
  warm(@Query('target') target?: string) {
    return this.cacheService.warm(target);
  }
}

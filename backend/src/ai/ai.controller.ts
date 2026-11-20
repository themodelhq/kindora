import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { PaginationDto } from '../common/dto/pagination.dto';
import { AiService } from './ai.service';
import { StoryDraftDto, StoryImproveDto, TranslateDto } from './dto/ai.dto';

@Controller('ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('story-draft')
  async storyDraft(@Body() dto: StoryDraftDto, @CurrentUser() user: AuthenticatedUser) {
    return this.ai.storyDraft(dto, user.id);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('story-improve')
  async storyImprove(@Body() dto: StoryImproveDto, @CurrentUser() user: AuthenticatedUser) {
    return this.ai.storyImprove(dto, user.id);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('translate')
  async translate(@Body() dto: TranslateDto, @CurrentUser() user: AuthenticatedUser) {
    return this.ai.translate(dto, user.id);
  }

  @Get('generations/mine')
  async generations(@CurrentUser() user: AuthenticatedUser, @Query() pagination: PaginationDto) {
    return this.ai.listMine(user.id, pagination.skip, pagination.limit);
  }
}

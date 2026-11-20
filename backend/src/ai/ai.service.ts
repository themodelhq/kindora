import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { AiKind, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { StoryDraftDto, StoryImproveDto, TranslateDto } from './dto/ai.dto';

const SYSTEM_PROMPT =
  'You write heartfelt, specific, honest crowdfunding campaign copy for KINDORA (a platform for verified social-impact causes). Plain paragraphs, no markdown headings, no emojis, no invented statistics; include placeholder amounts only when provided.';

const REQUEST_TIMEOUT_MS = 25_000;
const MAX_TOKENS = 700;
const TEMPERATURE = 0.7;

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(private readonly prisma: PrismaService) {}

  private settings() {
    const apiKey = process.env.AI_PROVIDER_API_KEY ?? '';
    if (!apiKey) {
      throw new BadRequestException('AI assistant is not configured');
    }
    const baseUrl = (process.env.AI_PROVIDER_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    const model = process.env.AI_PROVIDER_MODEL ?? 'gpt-4o-mini';
    return { apiKey, baseUrl, model };
  }

  /** Provider-agnostic OpenAI-compatible chat completion with a hard 25s timeout. */
  private async chat(userPrompt: string, systemPrompt: string = SYSTEM_PROMPT): Promise<string> {
    const { apiKey, baseUrl, model } = this.settings();
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: TEMPERATURE,
          max_tokens: MAX_TOKENS,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      this.logger.warn(`AI request failed: ${(err as Error).message}`);
      throw new ServiceUnavailableException('AI assistant is currently unavailable');
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.logger.warn(`AI provider returned ${response.status}: ${body.slice(0, 300)}`);
      throw new ServiceUnavailableException('AI assistant is currently unavailable');
    }

    const data = (await response.json().catch(() => null)) as ChatCompletionResponse | null;
    const content = data?.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new ServiceUnavailableException('AI assistant returned an empty response');
    }
    return content;
  }

  private async record(
    userId: string,
    kind: AiKind,
    input: Record<string, unknown>,
    output: string,
  ): Promise<{ id: string; kind: AiKind; output: string; createdAt: Date }> {
    const generation = await this.prisma.aiGeneration.create({
      data: {
        userId,
        kind,
        input: input as Prisma.InputJsonValue,
        output,
      },
      select: { id: true, kind: true, output: true, createdAt: true },
    });
    return generation;
  }

  async storyDraft(dto: StoryDraftDto, userId: string) {
    const fields = [
      `Campaign title: ${dto.title}`,
      `Category: ${dto.category}`,
      dto.country ? `Country: ${dto.country}` : null,
      dto.targetAmountMajor !== undefined
        ? `Fundraising target: ${dto.targetAmountMajor} (major units, mention it naturally)`
        : null,
      dto.keywords ? `Details to weave in: ${dto.keywords}` : null,
    ].filter(Boolean);

    const prompt = `Write a compelling 250-word crowdfunding campaign story for KINDORA based on these details:\n${fields.join('\n')}`;
    const output = await this.chat(prompt);
    const generation = await this.record(userId, 'STORY_DRAFT', { ...dto }, output);
    return { output, generation };
  }

  async storyImprove(dto: StoryImproveDto, userId: string) {
    const prompt = [
      'Improve the following crowdfunding campaign story: fix clarity, grammar and structure,',
      'keep every fact, name and amount exactly as given, add warmth without inventing facts,',
      'keep it around the same length and in plain paragraphs (no markdown).',
      '',
      'Story:',
      dto.story,
    ].join('\n');

    const output = await this.chat(prompt);
    const generation = await this.record(userId, 'STORY_IMPROVE', { storyLength: dto.story.length }, output);
    return { output, generation };
  }

  async translate(dto: TranslateDto, userId: string) {
    const prompt = [
      `Translate the following text into ${dto.targetLanguage}.`,
      'Preserve the meaning, tone and any factual details exactly. Return only the translation.',
      '',
      dto.text,
    ].join('\n');

    const output = await this.chat(prompt, 'You are a precise, natural-sounding translator for crowdfunding content.');
    const generation = await this.record(userId, 'TRANSLATION', { text: dto.text, targetLanguage: dto.targetLanguage }, output);
    return { output, generation };
  }

  async listMine(userId: string, skip: number, limit: number) {
    const [total, items] = await this.prisma.$transaction([
      this.prisma.aiGeneration.count({ where: { userId } }),
      this.prisma.aiGeneration.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: { id: true, kind: true, output: true, createdAt: true },
      }),
    ]);
    return { total, items };
  }
}

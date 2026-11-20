import { IsISO8601, IsString } from 'class-validator';

export class RecomputeDayDto {
  /** Calendar day to recompute, e.g. 2025-01-15. */
  @IsString()
  @IsISO8601()
  date: string;
}

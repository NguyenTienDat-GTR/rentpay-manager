import { SetMetadata } from '@nestjs/common';

export interface RetryableOptions {
  attempts?: number;
  delayMs?: number;
  methods?: string[];
}

export const RETRYABLE_KEY = 'retryable';
export const Retryable = (options: RetryableOptions = {}) => SetMetadata(RETRYABLE_KEY, options);

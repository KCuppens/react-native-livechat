import { z } from "zod";
import { Locale, Timestamp } from "./common";

export const FaqCategory = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  icon: z.string().nullable(),
  articleCount: z.number().int().nonnegative(),
});
export type FaqCategory = z.infer<typeof FaqCategory>;

export const FaqArticleSummary = z.object({
  id: z.string(),
  categoryId: z.string().nullable(),
  slug: z.string(),
  title: z.string(),
  /** Plain-text excerpt; for search results it is the matched snippet. */
  excerpt: z.string(),
  locale: Locale,
});
export type FaqArticleSummary = z.infer<typeof FaqArticleSummary>;

export const FaqArticle = FaqArticleSummary.extend({
  /** Markdown. SDKs must render it sanitized (no raw HTML). */
  bodyMd: z.string(),
  updatedAt: Timestamp,
});
export type FaqArticle = z.infer<typeof FaqArticle>;

export const FaqFeedbackRequest = z.object({ helpful: z.boolean() });
export type FaqFeedbackRequest = z.infer<typeof FaqFeedbackRequest>;

// ---------------------------------------------------------------- dashboard (agent) FAQ types

const Slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120);

export const FaqTranslationInput = z.object({
  title: z.string().min(1).max(200),
  /** Generated from the title when omitted. */
  slug: Slug.optional(),
  bodyMd: z.string().max(50_000),
  published: z.boolean().default(false),
});
export type FaqTranslationInput = z.input<typeof FaqTranslationInput>;

export const AgentFaqArticle = z.object({
  id: z.string(),
  categoryId: z.string().nullable(),
  position: z.number().int(),
  helpfulCount: z.number().int(),
  unhelpfulCount: z.number().int(),
  viewCount: z.number().int(),
  createdAt: Timestamp,
  translations: z.record(
    z.string(),
    z.object({ title: z.string(), slug: z.string(), bodyMd: z.string(), published: z.boolean(), updatedAt: Timestamp }),
  ),
});
export type AgentFaqArticle = z.infer<typeof AgentFaqArticle>;

export const SaveFaqArticleRequest = z.object({
  categoryId: z.string().nullable().optional(),
  position: z.number().int().optional(),
  /** Per-locale content; null deletes that translation. */
  translations: z.record(z.string(), FaqTranslationInput.nullable()).optional(),
});
export type SaveFaqArticleRequest = z.input<typeof SaveFaqArticleRequest>;

export const AgentFaqCategory = z.object({
  id: z.string(),
  slug: z.string(),
  icon: z.string().nullable(),
  position: z.number().int(),
  titles: z.record(z.string(), z.string()),
  descriptions: z.record(z.string(), z.string()),
});
export type AgentFaqCategory = z.infer<typeof AgentFaqCategory>;

export const SaveFaqCategoryRequest = z.object({
  slug: Slug.optional(),
  icon: z.string().max(50).nullable().optional(),
  position: z.number().int().optional(),
  titles: z.record(z.string(), z.string().min(1).max(100)).optional(),
  descriptions: z.record(z.string(), z.string().max(300)).optional(),
});
export type SaveFaqCategoryRequest = z.infer<typeof SaveFaqCategoryRequest>;

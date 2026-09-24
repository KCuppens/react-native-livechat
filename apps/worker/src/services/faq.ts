import type {
  AgentFaqArticle,
  AgentFaqCategory,
  FaqArticle,
  FaqArticleSummary,
  FaqCategory,
  SaveFaqArticleRequest,
  SaveFaqCategoryRequest,
} from "@kobecuppens/livechat-protocol";
import { ApiException, conflictOnUnique } from "../lib/errors";
import { newId } from "../lib/ids";
import { markdownExcerpt, slugify } from "../lib/markdown";
import type { WorkspaceRow } from "./workspaces";

interface TranslationRow {
  article_id: string;
  workspace_id: string;
  locale: string;
  slug: string;
  title: string;
  body_md: string;
  published: number;
  updated_at: number;
  category_id: string | null;
  position: number;
}

/** Locales to try for content, most preferred first: requested, then workspace default. */
export function contentLocales(ws: WorkspaceRow, requested: string | undefined): string[] {
  const supported = JSON.parse(ws.locales) as string[];
  const base = requested?.split("-")[0];
  const chain = base && supported.includes(base) ? [base] : [];
  if (!chain.includes(ws.default_locale)) chain.push(ws.default_locale);
  return chain;
}

/** Keeps the best-locale translation per article, in order of each article's first appearance. */
function pickBest<T extends { article_id: string; locale: string }>(rows: T[], locales: string[]): T[] {
  // A Map keeps each key's first insertion position even when set() replaces the value.
  const best = new Map<string, T>();
  for (const row of rows) {
    const current = best.get(row.article_id);
    if (!current || locales.indexOf(row.locale) < locales.indexOf(current.locale)) best.set(row.article_id, row);
  }
  return [...best.values()];
}

function summary(row: TranslationRow, excerpt?: string): FaqArticleSummary {
  return {
    id: row.article_id,
    categoryId: row.category_id,
    slug: row.slug,
    title: row.title,
    excerpt: excerpt ?? markdownExcerpt(row.body_md),
    locale: row.locale,
  };
}

const TRANSLATION_SELECT = `
  SELECT t.*, a.category_id, a.position
  FROM faq_article_translations t JOIN faq_articles a ON a.id = t.article_id`;

function localePlaceholders(locales: string[]) {
  return locales.map(() => "?").join(",");
}

export async function listCategories(db: D1Database, ws: WorkspaceRow, locale?: string): Promise<FaqCategory[]> {
  const locales = contentLocales(ws, locale);
  const { results } = await db
    .prepare("SELECT * FROM faq_categories WHERE workspace_id = ? ORDER BY position, slug")
    .bind(ws.id)
    .all<{ id: string; slug: string; icon: string | null; titles: string; descriptions: string }>();
  const { results: counts } = await db
    .prepare(
      `SELECT a.category_id, COUNT(DISTINCT a.id) AS n FROM faq_articles a
       JOIN faq_article_translations t ON t.article_id = a.id
       WHERE a.workspace_id = ? AND t.published = 1 AND t.locale IN (${localePlaceholders(locales)})
       GROUP BY a.category_id`,
    )
    .bind(ws.id, ...locales)
    .all<{ category_id: string | null; n: number }>();
  const pick = (json: string) => {
    const map = JSON.parse(json) as Record<string, string>;
    for (const l of locales) if (map[l]) return map[l];
    return Object.values(map)[0] ?? null;
  };
  return results
    .map((c) => ({
      id: c.id,
      slug: c.slug,
      title: pick(c.titles) ?? c.slug,
      description: pick(c.descriptions),
      icon: c.icon,
      articleCount: counts.find((n) => n.category_id === c.id)?.n ?? 0,
    }))
    .filter((c) => c.articleCount > 0);
}

/** Enough raw markdown for a 160-character excerpt, even after stripping syntax and code. */
const EXCERPT_SOURCE_CHARS = 2000;

export async function listArticles(
  db: D1Database,
  ws: WorkspaceRow,
  opts: { locale?: string; categoryId?: string; sort: "position" | "popular"; limit: number },
): Promise<FaqArticleSummary[]> {
  const locales = contentLocales(ws, opts.locale);
  const where = ["t.workspace_id = ?", "t.published = 1", `t.locale IN (${localePlaceholders(locales)})`];
  const binds: unknown[] = [ws.id, ...locales];
  if (opts.categoryId) {
    where.push("a.category_id = ?");
    binds.push(opts.categoryId);
  }
  const order = opts.sort === "popular" ? "view_count DESC, helpful_count DESC, article_id" : "position, title, article_id";
  // Best locale per article (requested before default) and the limit are applied in SQL, and
  // only the start of each body is read: the help home shows 5 excerpts, not every article.
  const localeRank = `CASE t.locale ${locales.map((_, i) => `WHEN ? THEN ${i}`).join(" ")} END`;
  const { results } = await db
    .prepare(
      `SELECT * FROM (
         SELECT t.article_id, t.workspace_id, t.locale, t.slug, t.title, substr(t.body_md, 1, ${EXCERPT_SOURCE_CHARS}) AS body_md,
           t.published, t.updated_at, a.category_id, a.position, a.view_count, a.helpful_count,
           ROW_NUMBER() OVER (PARTITION BY t.article_id ORDER BY ${localeRank}) AS rn
         FROM faq_article_translations t JOIN faq_articles a ON a.id = t.article_id
         WHERE ${where.join(" AND ")}
       ) WHERE rn = 1 ORDER BY ${order} LIMIT ?`,
    )
    .bind(...locales, ...binds, opts.limit)
    .all<TranslationRow>();
  return results.map((r) => summary(r));
}

/**
 * Turns user input into a safe FTS5 query. "all" = every term must match (search box);
 * "any" = rank by overlap (suggesting articles from a chat message).
 */
export function ftsQuery(input: string, mode: "all" | "any"): string | null {
  const terms = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => (mode === "any" ? t.length >= 3 : t.length >= 1))
    .slice(0, 12);
  if (terms.length === 0) return null;
  // Quote each term (no FTS syntax injection); prefix-match the last one while typing.
  const quoted = terms.map((t, i) => (mode === "all" && i === terms.length - 1 ? `"${t}"*` : `"${t}"`));
  return quoted.join(mode === "all" ? " AND " : " OR ");
}

export async function searchArticles(
  db: D1Database,
  ws: WorkspaceRow,
  opts: { q: string; locale?: string; mode: "all" | "any"; limit: number },
): Promise<FaqArticleSummary[]> {
  const match = ftsQuery(opts.q, opts.mode);
  if (!match) return [];
  const locales = contentLocales(ws, opts.locale);
  // Scoped to this workspace inside the MATCH (workspace_id is an indexed column; ids are
  // lowercase fixed-length tokens, so the phrase is exact), so other tenants' hits are never
  // visited. The user's terms only search title and body.
  if (!/^[a-z0-9_]+$/.test(ws.id)) throw new Error("unexpected workspace id format");
  const scoped = `workspace_id:"${ws.id}" AND {title body_md}:(${match})`;
  const { results } = await db
    .prepare(
      `SELECT t.*, a.category_id, a.position, snippet(faq_fts, 1, '', '', '…', 16) AS snippet
       FROM faq_fts f
       JOIN faq_article_translations t ON t.id = f.rowid
       JOIN faq_articles a ON a.id = t.article_id
       WHERE faq_fts MATCH ? AND t.workspace_id = ? AND t.published = 1 AND t.locale IN (${localePlaceholders(locales)})
       ORDER BY f.rank LIMIT ?`,
    )
    .bind(scoped, ws.id, ...locales, opts.limit * 2)
    .all<TranslationRow & { snippet: string }>();
  return pickBest(results, locales)
    .slice(0, opts.limit)
    .map((r) => summary(r, markdownExcerpt(r.snippet)));
}

export async function getArticleBySlug(db: D1Database, ws: WorkspaceRow, slug: string, locale?: string): Promise<FaqArticle> {
  const locales = contentLocales(ws, locale);
  // The slug may belong to any locale (shared links); then serve the best available translation.
  // locale IN (every workspace locale) turns this into equality seeks on UNIQUE(workspace_id,
  // locale, slug) instead of scanning the workspace's translations.
  const all = JSON.parse(ws.locales) as string[];
  const hit = await db
    .prepare(
      `SELECT article_id FROM faq_article_translations
       WHERE workspace_id = ? AND locale IN (${localePlaceholders(all)}) AND slug = ? AND published = 1 ORDER BY locale = ? DESC LIMIT 1`,
    )
    .bind(ws.id, ...all, slug, locales[0])
    .first<{ article_id: string }>();
  if (!hit) throw new ApiException(404, "article_not_found", "Article not found");
  const { results } = await db
    .prepare(`${TRANSLATION_SELECT} WHERE t.article_id = ? AND t.published = 1`)
    .bind(hit.article_id)
    .all<TranslationRow>();
  const row =
    pickBest(results.filter((r) => locales.includes(r.locale)), locales)[0] ??
    results.find((r) => r.slug === slug)!;
  return { ...summary(row), bodyMd: row.body_md, updatedAt: row.updated_at };
}

export async function recordView(db: D1Database, workspaceId: string, articleId: string) {
  await db.prepare("UPDATE faq_articles SET view_count = view_count + 1 WHERE id = ? AND workspace_id = ?").bind(articleId, workspaceId).run();
}

export async function recordFeedback(db: D1Database, workspaceId: string, articleId: string, helpful: boolean) {
  const column = helpful ? "helpful_count" : "unhelpful_count";
  const res = await db
    .prepare(`UPDATE faq_articles SET ${column} = ${column} + 1 WHERE id = ? AND workspace_id = ?`)
    .bind(articleId, workspaceId)
    .run();
  if (res.meta.changes === 0) throw new ApiException(404, "article_not_found", "Article not found");
}

// ---------------------------------------------------------------- dashboard CRUD

interface ArticleRow {
  id: string;
  category_id: string | null;
  position: number;
  helpful_count: number;
  unhelpful_count: number;
  view_count: number;
  created_at: number;
}

function toAgentArticle(a: ArticleRow, translations: TranslationRow[]): AgentFaqArticle {
  return {
    id: a.id,
    categoryId: a.category_id,
    position: a.position,
    helpfulCount: a.helpful_count,
    unhelpfulCount: a.unhelpful_count,
    viewCount: a.view_count,
    createdAt: a.created_at,
    translations: Object.fromEntries(
      translations
        .filter((t) => t.article_id === a.id)
        .map((t) => [t.locale, { title: t.title, slug: t.slug, bodyMd: t.body_md, published: t.published === 1, updatedAt: t.updated_at }]),
    ),
  };
}

export async function listAgentArticles(db: D1Database, workspaceId: string): Promise<AgentFaqArticle[]> {
  const [{ results: articles }, { results: translations }] = await Promise.all([
    db.prepare("SELECT * FROM faq_articles WHERE workspace_id = ? ORDER BY position, created_at").bind(workspaceId).all<ArticleRow>(),
    db.prepare("SELECT * FROM faq_article_translations WHERE workspace_id = ?").bind(workspaceId).all<TranslationRow>(),
  ]);
  return articles.map((a) => toAgentArticle(a, translations));
}

export async function getAgentArticle(db: D1Database, workspaceId: string, id: string): Promise<AgentFaqArticle> {
  const [article, { results: translations }] = await Promise.all([
    db.prepare("SELECT * FROM faq_articles WHERE id = ? AND workspace_id = ?").bind(id, workspaceId).first<ArticleRow>(),
    db.prepare("SELECT * FROM faq_article_translations WHERE article_id = ? AND workspace_id = ?").bind(id, workspaceId).all<TranslationRow>(),
  ]);
  if (!article) throw new ApiException(404, "article_not_found", "Article not found");
  return toAgentArticle(article, translations);
}

async function assertCategory(db: D1Database, workspaceId: string, categoryId: string | null | undefined) {
  if (!categoryId) return;
  const cat = await db.prepare("SELECT id FROM faq_categories WHERE id = ? AND workspace_id = ?").bind(categoryId, workspaceId).first();
  if (!cat) throw new ApiException(400, "invalid_category", "Category not found");
}

export async function saveArticle(
  db: D1Database,
  ws: WorkspaceRow,
  id: string | null,
  input: SaveFaqArticleRequest,
): Promise<AgentFaqArticle> {
  await assertCategory(db, ws.id, input.categoryId);
  const supported = JSON.parse(ws.locales) as string[];
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  let articleId = id;

  if (!articleId) {
    articleId = newId("art");
    statements.push(
      db.prepare("INSERT INTO faq_articles (id, workspace_id, category_id, position, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(articleId, ws.id, input.categoryId ?? null, input.position ?? 0, now),
    );
  } else {
    const exists = await db.prepare("SELECT id FROM faq_articles WHERE id = ? AND workspace_id = ?").bind(articleId, ws.id).first();
    if (!exists) throw new ApiException(404, "article_not_found", "Article not found");
    if (input.categoryId !== undefined) {
      statements.push(db.prepare("UPDATE faq_articles SET category_id = ? WHERE id = ?").bind(input.categoryId, articleId));
    }
    if (input.position !== undefined) {
      statements.push(db.prepare("UPDATE faq_articles SET position = ? WHERE id = ?").bind(input.position, articleId));
    }
  }

  for (const [locale, t] of Object.entries(input.translations ?? {})) {
    if (!supported.includes(locale)) throw new ApiException(400, "unsupported_locale", `Locale ${locale} is not enabled for this workspace`);
    if (t === null) {
      statements.push(db.prepare("DELETE FROM faq_article_translations WHERE article_id = ? AND locale = ?").bind(articleId, locale));
      continue;
    }
    statements.push(
      db
        .prepare(
          `INSERT INTO faq_article_translations (article_id, workspace_id, locale, slug, title, body_md, published, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (article_id, locale) DO UPDATE SET
             slug = excluded.slug, title = excluded.title, body_md = excluded.body_md,
             published = excluded.published, updated_at = excluded.updated_at`,
        )
        .bind(articleId, ws.id, locale, t.slug ?? slugify(t.title), t.title, t.bodyMd, t.published ? 1 : 0, now),
    );
  }

  try {
    await db.batch(statements);
  } catch (err) {
    if (String(err).includes("UNIQUE") && String(err).includes("slug")) {
      throw new ApiException(409, "slug_taken", "Another article already uses this slug in that language");
    }
    throw err;
  }
  return getAgentArticle(db, ws.id, articleId);
}

export async function deleteArticle(db: D1Database, workspaceId: string, id: string) {
  // Translations cascade; the FTS delete trigger fires per translation row.
  await db.batch([
    db.prepare("DELETE FROM faq_article_translations WHERE article_id = ? AND workspace_id = ?").bind(id, workspaceId),
    db.prepare("DELETE FROM faq_articles WHERE id = ? AND workspace_id = ?").bind(id, workspaceId),
  ]);
}

interface CategoryRow {
  id: string;
  slug: string;
  icon: string | null;
  position: number;
  titles: string;
  descriptions: string;
}

function toAgentCategory(c: CategoryRow): AgentFaqCategory {
  return {
    id: c.id,
    slug: c.slug,
    icon: c.icon,
    position: c.position,
    titles: JSON.parse(c.titles),
    descriptions: JSON.parse(c.descriptions),
  };
}

export async function listAgentCategories(db: D1Database, workspaceId: string): Promise<AgentFaqCategory[]> {
  const { results } = await db.prepare("SELECT * FROM faq_categories WHERE workspace_id = ? ORDER BY position, slug").bind(workspaceId).all<CategoryRow>();
  return results.map(toAgentCategory);
}

export async function saveCategory(db: D1Database, workspaceId: string, id: string | null, input: SaveFaqCategoryRequest) {
  if (id) {
    const existing = await db.prepare("SELECT * FROM faq_categories WHERE id = ? AND workspace_id = ?").bind(id, workspaceId).first<CategoryRow>();
    if (!existing) throw new ApiException(404, "category_not_found", "Category not found");
    await db
      .prepare("UPDATE faq_categories SET slug = ?, icon = ?, position = ?, titles = ?, descriptions = ? WHERE id = ?")
      .bind(
        input.slug ?? existing.slug,
        input.icon !== undefined ? input.icon : existing.icon,
        input.position ?? existing.position,
        input.titles ? JSON.stringify(input.titles) : existing.titles,
        input.descriptions ? JSON.stringify(input.descriptions) : existing.descriptions,
        id,
      )
      .run()
      .catch(conflictOnUnique("slug_taken", "Category slug already in use"));
  } else {
    const titles = input.titles ?? {};
    const slug = input.slug ?? slugify(Object.values(titles)[0] ?? "category");
    id = newId("cat");
    await db
      .prepare("INSERT INTO faq_categories (id, workspace_id, slug, icon, position, titles, descriptions) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, workspaceId, slug, input.icon ?? null, input.position ?? 0, JSON.stringify(titles), JSON.stringify(input.descriptions ?? {}))
      .run()
      .catch(conflictOnUnique("slug_taken", "Category slug already in use"));
  }
  return toAgentCategory((await db.prepare("SELECT * FROM faq_categories WHERE id = ?").bind(id).first<CategoryRow>())!);
}

export async function deleteCategory(db: D1Database, workspaceId: string, id: string) {
  await db.batch([
    db.prepare("UPDATE faq_articles SET category_id = NULL WHERE category_id = ? AND workspace_id = ?").bind(id, workspaceId),
    db.prepare("DELETE FROM faq_categories WHERE id = ? AND workspace_id = ?").bind(id, workspaceId),
  ]);
}

import type { AgentFaqArticle, AgentFaqCategory, FaqTranslationInput, WorkspaceSettings } from "@kobecuppens/livechat-protocol";
import { Markdown } from "@kobecuppens/livechat-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { attempt, Field, Spinner, toast } from "../components/ui";
import { t as translateNow, useI18n } from "../i18n";
import { Link, useRouter } from "../router";

const titleOf = (a: AgentFaqArticle, locale: string) =>
  a.translations[locale]?.title ?? Object.values(a.translations)[0]?.title ?? translateNow("faq.untitled");

export function FaqPage({ workspaceId, articleId }: { workspaceId: string; articleId: string | null }) {
  const { t } = useI18n();
  const [articles, setArticles] = useState<AgentFaqArticle[] | null>(null);
  const [categories, setCategories] = useState<AgentFaqCategory[]>([]);
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null);

  const [loadFailed, setLoadFailed] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [a, c, s] = await Promise.all([api.faqArticles(workspaceId), api.faqCategories(workspaceId), api.settings(workspaceId)]);
      setArticles(a);
      setCategories(c);
      setSettings(s);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
      toast(translateNow("faq.loadFailedToast"));
    }
  }, [workspaceId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (!articles || !settings) {
    return loadFailed ? (
      <div className="empty">
        {t("faq.loadFailed")}{" "}
        <button type="button" className="btn btn-sm" onClick={() => void reload()}>
          {t("common.retry")}
        </button>
      </div>
    ) : (
      <Spinner />
    );
  }
  if (articleId) {
    const article = articleId === "new" ? null : articles.find((a) => a.id === articleId);
    if (articleId !== "new" && !article) {
      return (
        <div className="empty">
          {t("faq.notFound")} <Link to={`/w/${workspaceId}/faq`}>{t("faq.backToList")}</Link>
        </div>
      );
    }
    return <ArticleEditor key={articleId} workspaceId={workspaceId} article={article ?? null} categories={categories} settings={settings} onSaved={reload} />;
  }
  return <ArticleList workspaceId={workspaceId} articles={articles} categories={categories} settings={settings} onChange={reload} />;
}

function ArticleList({
  workspaceId,
  articles,
  categories,
  settings,
  onChange,
}: {
  workspaceId: string;
  articles: AgentFaqArticle[];
  categories: AgentFaqCategory[];
  settings: WorkspaceSettings;
  onChange: () => Promise<void>;
}) {
  const { navigate } = useRouter();
  const { t } = useI18n();
  const [newCategory, setNewCategory] = useState("");
  const locale = settings.defaultLocale;
  const groups = [...categories.map((c) => ({ id: c.id as string | null, title: c.titles[locale] ?? c.slug })), { id: null, title: t("faq.uncategorized") }];

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>{t("nav.faq")}</h1>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            {t("faq.intro")}
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => navigate(`/w/${workspaceId}/faq/new`)}>
          {t("faq.newArticle")}
        </button>
      </div>

      <div className="card">
        <h2>{t("faq.categories")}</h2>
        <p className="muted">{t("faq.categoriesIntro")}</p>
        <table className="table">
          <tbody>
            {categories.map((c) => (
              <CategoryRow key={c.id} workspaceId={workspaceId} category={c} locales={settings.locales} onChange={onChange} />
            ))}
          </tbody>
        </table>
        <form
          className="row"
          style={{ marginTop: 12 }}
          onSubmit={async (e) => {
            e.preventDefault();
            if (!newCategory.trim()) return;
            await attempt(async () => {
              await api.saveFaqCategory(workspaceId, null, { titles: { [locale]: newCategory.trim() }, position: categories.length });
              setNewCategory("");
              await onChange();
            }, t("faq.addCategoryFailed"));
          }}
        >
          <input className="input" aria-label={t("faq.newCategoryPlaceholder", { locale })} placeholder={t("faq.newCategoryPlaceholder", { locale })} value={newCategory} onChange={(e) => setNewCategory(e.target.value)} style={{ maxWidth: 320 }} />
          <button type="submit" className="btn">{t("faq.addCategory")}</button>
        </form>
      </div>

      {articles.length === 0 ? (
        <div className="card empty">{t("faq.noArticles")}</div>
      ) : (
        groups.map((g) => {
          const list = articles.filter((a) => a.categoryId === g.id);
          if (list.length === 0) return null;
          return (
            <div className="card" key={g.id ?? "none"}>
              <h2 style={{ marginBottom: 12 }}>{g.title}</h2>
              <table className="table">
                <thead>
                  <tr>
                    <th>{t("common.title")}</th>
                    <th>{t("faq.languages")}</th>
                    <th>{t("faq.views")}</th>
                    <th>{t("faq.helpful")}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((a) => {
                    const votes = a.helpfulCount + a.unhelpfulCount;
                    return (
                      // The row click is a mouse shortcut; the title link is the keyboard/screen-reader path.
                      <tr
                        key={a.id}
                        className="clickable"
                        onClick={(e) => {
                          // Clicks on the title link (incl. Cmd/Ctrl-click for a new tab) are the link's.
                          if ((e.target as HTMLElement).closest("a, button") || e.metaKey || e.ctrlKey || e.shiftKey) return;
                          navigate(`/w/${workspaceId}/faq/${a.id}`);
                        }}
                      >
                        <td>
                          <Link to={`/w/${workspaceId}/faq/${a.id}`}>{titleOf(a, locale)}</Link>
                        </td>
                        <td>
                          {settings.locales.map((l) => (
                            <span
                              key={l}
                              className={`badge${a.translations[l]?.published ? " badge-open" : ""}`}
                              style={{ marginRight: 4, opacity: a.translations[l] ? 1 : 0.4 }}
                              title={a.translations[l] ? (a.translations[l]!.published ? t("faq.published") : t("faq.draft")) : t("faq.missing")}
                            >
                              {l}
                              <span className="sr-only">: {a.translations[l] ? (a.translations[l]!.published ? t("faq.published") : t("faq.draft")) : t("faq.missing")}</span>
                            </span>
                          ))}
                        </td>
                        <td>{a.viewCount}</td>
                        <td>{votes ? t("faq.helpfulValue", { percent: Math.round((a.helpfulCount / votes) * 100), votes }) : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        })
      )}
    </div>
  );
}

function CategoryRow({ workspaceId, category, locales, onChange }: { workspaceId: string; category: AgentFaqCategory; locales: string[]; onChange: () => Promise<void> }) {
  const { t } = useI18n();
  const [titles, setTitles] = useState(category.titles);
  const dirty = JSON.stringify(titles) !== JSON.stringify(category.titles);
  return (
    <tr>
      {locales.map((l) => (
        <td key={l}>
          <input className="input" aria-label={t("faq.categoryTitle", { locale: l })} placeholder={l} value={titles[l] ?? ""} onChange={(e) => setTitles({ ...titles, [l]: e.target.value })} />
        </td>
      ))}
      <td style={{ width: 1, whiteSpace: "nowrap" }}>
        <button type="button"
          className="btn btn-sm"
          disabled={!dirty}
          onClick={async () => {
            const clean = Object.fromEntries(Object.entries(titles).filter(([, v]) => v.trim()));
            if (!(await attempt(() => api.saveFaqCategory(workspaceId, category.id, { titles: clean }), t("faq.saveCategoryFailed")))) return;
            toast(t("faq.categorySaved"));
            await onChange();
          }}
        >
          {t("common.save")}
        </button>{" "}
        <button type="button"
          className="btn btn-sm btn-danger"
          onClick={async () => {
            if (!confirm(t("faq.deleteCategoryConfirm"))) return;
            if (await attempt(() => api.deleteFaqCategory(workspaceId, category.id), t("faq.deleteCategoryFailed"))) await onChange();
          }}
        >
          {t("common.delete")}
        </button>
      </td>
    </tr>
  );
}

type Draft = Record<string, FaqTranslationInput & { slug?: string }>;

function ArticleEditor({
  workspaceId,
  article,
  categories,
  settings,
  onSaved,
}: {
  workspaceId: string;
  article: AgentFaqArticle | null;
  categories: AgentFaqCategory[];
  settings: WorkspaceSettings;
  onSaved: () => Promise<void>;
}) {
  const { navigate } = useRouter();
  const { t } = useI18n();
  const [locale, setLocale] = useState(settings.defaultLocale);
  const [categoryId, setCategoryId] = useState<string | null>(article?.categoryId ?? null);
  const [draft, setDraft] = useState<Draft>(() =>
    Object.fromEntries(Object.entries(article?.translations ?? {}).map(([l, t]) => [l, { title: t.title, slug: t.slug, bodyMd: t.bodyMd, published: t.published }])),
  );
  const [removed, setRemoved] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const current = draft[locale];

  const [untitledLocale, setUntitledLocale] = useState<string | null>(null);
  const setField = (patch: Partial<FaqTranslationInput>) => {
    if (patch.title?.trim()) setUntitledLocale(null);
    setRemoved((r) => r.filter((l) => l !== locale));
    setDraft((d) => ({ ...d, [locale]: { title: "", bodyMd: "", published: false, ...d[locale], ...patch } }));
  };

  const save = async () => {
    // A translation that has content (or already exists) but no title would be skipped silently:
    // stop and point at it instead of saying "Saved".
    const untitled = Object.entries(draft).find(([l, t]) => !t.title.trim() && !removed.includes(l) && (t.bodyMd.trim() || article?.translations[l]))?.[0];
    if (untitled) {
      setLocale(untitled);
      setUntitledLocale(untitled);
      return;
    }
    const translations: Record<string, FaqTranslationInput | null> = {};
    for (const [l, t] of Object.entries(draft)) {
      if (!t.title.trim()) continue;
      translations[l] = { ...t, title: t.title.trim(), slug: t.slug?.trim() || undefined };
    }
    for (const l of removed) translations[l] = null;
    if (Object.values(translations).every((t) => t === null) && !article) {
      toast(t("faq.addTitleFirst"));
      return;
    }
    setSaving(true);
    await attempt(async () => {
      const saved = await api.saveFaqArticle(workspaceId, article?.id ?? null, { categoryId, translations });
      await onSaved();
      toast(t("common.saved"));
      if (!article) navigate(`/w/${workspaceId}/faq/${saved.id}`, true);
    }, t("common.saveFailed"));
    setSaving(false);
  };

  return (
    <div className="page">
      <div className="page-header">
        <div className="row">
          <button type="button" className="btn btn-sm" onClick={() => navigate(`/w/${workspaceId}/faq`)}>
            {t("common.back")}
          </button>
          <h1>{article ? titleOf(article, settings.defaultLocale) : t("faq.newArticle")}</h1>
        </div>
        <div className="row">
          {article && (
            <button type="button"
              className="btn btn-danger"
              onClick={async () => {
                if (!confirm(t("faq.deleteArticleConfirm"))) return;
                if (!(await attempt(() => api.deleteFaqArticle(workspaceId, article.id), t("faq.deleteArticleFailed")))) return;
                await onSaved();
                navigate(`/w/${workspaceId}/faq`);
              }}
            >
              {t("common.delete")}
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving}>
            {saving ? t("common.saving") : t("common.save")}
          </button>
        </div>
      </div>

      <div className="row" style={{ marginBottom: 16, maxWidth: 360 }}>
        <Field label={t("faq.category")}>
          <select className="select" value={categoryId ?? ""} onChange={(e) => setCategoryId(e.target.value || null)}>
            <option value="">{t("faq.uncategorized")}</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.titles[settings.defaultLocale] ?? c.slug}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="tabs" role="tablist">
        {settings.locales.map((l) => (
          <button type="button" key={l} role="tab" aria-selected={l === locale} className={l === locale ? "active" : ""} onClick={() => setLocale(l)}>
            {l.toUpperCase()}
            {draft[l]?.title && (
              <>
                <span aria-hidden="true">{draft[l]!.published ? " ●" : " ○"}</span>
                <span className="sr-only">{` (${draft[l]!.published ? t("faq.published") : t("faq.draft")})`}</span>
              </>
            )}
          </button>
        ))}
      </div>

      <div className="split">
        <div>
          <Field label={t("common.title")}>
            <input
              className="input"
              value={current?.title ?? ""}
              onChange={(e) => setField({ title: e.target.value })}
              placeholder={t("faq.titlePlaceholder")}
              aria-invalid={untitledLocale === locale}
              aria-describedby={untitledLocale === locale ? "untitled-error" : undefined}
            />
            {untitledLocale === locale && (
              <div className="error-text" role="alert" id="untitled-error">
                {article?.translations[locale]
                  ? t("faq.untitledExisting", { locale: locale.toUpperCase() })
                  : t("faq.untitledNew", { locale: locale.toUpperCase() })}
              </div>
            )}
          </Field>
          <Field label={t("faq.slug")} hint={t("faq.slugHint")}>
            <input className="input" value={current?.slug ?? ""} onChange={(e) => setField({ slug: e.target.value.toLowerCase() })} placeholder="how-do-i" />
          </Field>
          <Field label={t("faq.body")} hint={t("faq.bodyHint")}>
            <textarea className="textarea" style={{ minHeight: 360, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13 }} value={current?.bodyMd ?? ""} onChange={(e) => setField({ bodyMd: e.target.value })} />
          </Field>
          <div className="row">
            <label className="row">
              <input type="checkbox" checked={current?.published ?? false} onChange={(e) => setField({ published: e.target.checked })} disabled={!current?.title} />
              {t("faq.publishedIn", { locale: locale.toUpperCase() })}
            </label>
            {article?.translations[locale] && !removed.includes(locale) && (
              <button type="button"
                className="btn btn-sm btn-danger"
                style={{ marginLeft: "auto" }}
                onClick={() => {
                  setRemoved((r) => [...r, locale]);
                  setDraft(({ [locale]: _, ...rest }) => rest);
                  setUntitledLocale((u) => (u === locale ? null : u));
                }}
              >
                {t("faq.removeTranslation", { locale: locale.toUpperCase() })}
              </button>
            )}
          </div>
        </div>
        <div>
          <div className="field">
            <span>{t("faq.preview")}</span>
          </div>
          <div className="preview">
            <h2 style={{ marginBottom: 12 }}>{current?.title || <span className="muted">{t("faq.untitledPreview")}</span>}</h2>
            <Markdown source={current?.bodyMd ?? ""} images />
          </div>
        </div>
      </div>
    </div>
  );
}

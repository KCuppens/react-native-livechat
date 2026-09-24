import type { FaqArticleSummary } from "@kobecuppens/livechat-core";
import { useMessenger, useTranslate } from "../../hooks/context";
import { useArticle, useCategoryArticles } from "../../hooks/data";
import { ChatIcon, ChevronIcon } from "../icons";
import { Markdown } from "../markdown";
import { ErrorState, Header, Loading } from "./shared";

export function ArticleRows({ articles }: { articles: FaqArticleSummary[] }) {
  const messenger = useMessenger();
  return (
    <>
      {articles.map((a) => (
        <button type="button" key={a.id} className="lc-row" onClick={() => messenger.navigate({ name: "article", slug: a.slug })}>
          <div className="lc-row-main">
            <strong>{a.title}</strong>
            {a.excerpt && <span>{a.excerpt}</span>}
          </div>
          <ChevronIcon />
        </button>
      ))}
    </>
  );
}

export function CategoryScreen({ id, title }: { id: string; title: string }) {
  const { data, loading, error, reload } = useCategoryArticles(id);
  return (
    <>
      <Header title={title} />
      <div className="lc-body">
        {loading && !data ? <Loading /> : error ? <ErrorState onRetry={reload} /> : <ArticleRows articles={data ?? []} />}
      </div>
    </>
  );
}

export function ArticleScreen({ slug }: { slug: string }) {
  const t = useTranslate();
  const messenger = useMessenger();
  const { data, loading, error, reload, feedback, sendFeedback } = useArticle(slug);
  return (
    <>
      <Header title={data?.title ?? ""} />
      <div className="lc-body">
        {loading && !data ? (
          <Loading />
        ) : error || !data ? (
          <ErrorState onRetry={reload} />
        ) : (
          <>
            <article className="lc-article">
              <h1>{data.title}</h1>
              <Markdown source={data.bodyMd} images />
            </article>
            <div className="lc-feedback">
              {feedback === null ? (
                <>
                  <div>{t("faq.helpful")}</div>
                  <div className="lc-feedback-btns">
                    <button type="button" className="lc-pill" onClick={() => sendFeedback(true)}>
                      👍 {t("faq.yes")}
                    </button>
                    <button type="button" className="lc-pill" onClick={() => sendFeedback(false)}>
                      👎 {t("faq.no")}
                    </button>
                  </div>
                </>
              ) : (
                <div>{t("faq.thanks")}</div>
              )}
            </div>
            <div className="lc-still">
              <span>{t("faq.stillNeedHelp")}</span>
              <button type="button" className="lc-btn" onClick={() => messenger.navigate({ name: "new" })}>
                <ChatIcon />
                {t("home.startChat")}
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

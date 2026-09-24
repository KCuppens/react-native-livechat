import { useArticle, useCategoryArticles, useMessenger, useTranslate } from "@kobecuppens/livechat-react/hooks";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Markdown } from "../Markdown";
import { useTheme } from "../theme";
import { ErrorState, Header, Loading, PrimaryButton, Row } from "./shared";

export function CategoryScreen({ id, title, onClose }: { id: string; title: string; onClose?: () => void }) {
  const theme = useTheme();
  const messenger = useMessenger();
  const { data, loading, error, reload } = useCategoryArticles(id);
  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <Header title={title} onClose={onClose} />
      <ScrollView>
        {loading && !data ? <Loading /> : error ? <ErrorState onRetry={reload} /> : (data ?? []).map((a, i) => <Row key={a.id} first={i === 0} title={a.title} subtitle={a.excerpt} onPress={() => messenger.navigate({ name: "article", slug: a.slug })} />)}
      </ScrollView>
    </View>
  );
}

export function ArticleScreen({ slug, onClose }: { slug: string; onClose?: () => void }) {
  const theme = useTheme();
  const t = useTranslate();
  const messenger = useMessenger();
  const { data, loading, error, reload, feedback, sendFeedback } = useArticle(slug);
  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <Header title={data?.title ?? ""} onClose={onClose} />
      {loading && !data ? (
        <Loading />
      ) : error || !data ? (
        <ErrorState onRetry={reload} />
      ) : (
        <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40 }}>
          <Text style={{ color: theme.text, fontSize: 24, fontWeight: "700", marginBottom: 16 }} accessibilityRole="header">
            {data.title}
          </Text>
          <Markdown source={data.bodyMd} images />
          <View style={{ marginTop: 28, padding: 16, borderRadius: 14, backgroundColor: theme.surface, alignItems: "center" }}>
            {feedback === null ? (
              <>
                <Text style={{ color: theme.text }}>{t("faq.helpful")}</Text>
                <View style={{ flexDirection: "row", gap: 10, marginTop: 10 }}>
                  {[true, false].map((helpful) => (
                    <Pressable
                      key={String(helpful)}
                      onPress={() => sendFeedback(helpful)}
                      accessibilityRole="button"
                      style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.bg, borderRadius: 999, paddingHorizontal: 18, paddingVertical: 8 }}
                    >
                      <Text style={{ color: theme.text, fontWeight: "500" }}>{helpful ? `👍 ${t("faq.yes")}` : `👎 ${t("faq.no")}`}</Text>
                    </Pressable>
                  ))}
                </View>
              </>
            ) : (
              <Text style={{ color: theme.text }}>{t("faq.thanks")}</Text>
            )}
          </View>
          <View style={{ marginTop: 20, gap: 10 }}>
            <Text style={{ color: theme.muted, textAlign: "center" }}>{t("faq.stillNeedHelp")}</Text>
            <PrimaryButton title={t("home.startChat")} onPress={() => messenger.navigate({ name: "new" })} />
          </View>
        </ScrollView>
      )}
    </View>
  );
}

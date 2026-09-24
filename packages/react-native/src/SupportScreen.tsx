import { useLiveChatClient, useLiveChatState, useMessenger, useTranslate } from "@kobecuppens/livechat-react/hooks";
import { Component, useEffect, type ErrorInfo, type ReactNode } from "react";
import { BackHandler, KeyboardAvoidingView, Modal, Platform, View } from "react-native";
import { ArticleScreen, CategoryScreen } from "./screens/Articles";
import { ChatScreen } from "./screens/Chat";
import { ConversationsScreen } from "./screens/Conversations";
import { HomeScreen } from "./screens/Home";
import { ErrorState, Header, Loading } from "./screens/shared";
import { ThemeOverridesContext, useTheme, type ThemeOverrides } from "./theme";

export interface SupportScreenProps {
  /** Shows a close button that calls this (e.g. navigation.goBack). */
  onClose?: () => void;
  theme?: ThemeOverrides;
  /** Extra padding for safe areas when you don't wrap it in your own SafeAreaView. */
  insets?: { top?: number; bottom?: number };
  /** Offset for KeyboardAvoidingView (height of any header above this screen). */
  keyboardVerticalOffset?: number;
}

function Screens({ onClose }: { onClose?: () => void }) {
  const { route } = useMessenger();
  const status = useLiveChatState((s) => s.status);
  const client = useLiveChatClient();
  if (status === "error") return <WithHeader onClose={onClose}><ErrorState onRetry={() => void client.init().catch(() => {})} /></WithHeader>;
  if (status !== "ready") return <WithHeader onClose={onClose}><Loading /></WithHeader>;
  switch (route.name) {
    case "home":
    case "search":
      return <HomeScreen onClose={onClose} />;
    case "conversations":
      return <ConversationsScreen onClose={onClose} />;
    case "conversation":
      return <ChatScreen key={route.id} conversationId={route.id} onClose={onClose} />;
    case "new":
      return <ChatScreen key="new" conversationId={null} onClose={onClose} />;
    case "category":
      return <CategoryScreen id={route.id} title={route.title} onClose={onClose} />;
    case "article":
      return <ArticleScreen key={route.slug} slug={route.slug} onClose={onClose} />;
  }
}

/**
 * Keeps a render error inside the support UI: it renders server/agent-supplied content, and a
 * crash must not take down the host app (red screen in dev, crash in production).
 */
class SupportErrorBoundary extends Component<{ children: ReactNode; fallback: (reset: () => void) => ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[livechat] render error", error, info.componentStack);
  }

  override render() {
    return this.state.failed ? this.props.fallback(() => this.setState({ failed: false })) : this.props.children;
  }
}

/**
 * Loading, init-error and crashed screens keep the header (Back and Close): iOS has no hardware
 * back button, so a bare error would trap the user.
 */
function WithHeader({ onClose, children }: { onClose?: () => void; children: ReactNode }) {
  const t = useTranslate();
  return (
    <>
      <Header title={t("home.title")} onClose={onClose} />
      {children}
    </>
  );
}

function Body({ onClose, insets, keyboardVerticalOffset }: SupportScreenProps) {
  const theme = useTheme();
  const messenger = useMessenger();

  // Android back button walks the in-support stack before leaving.
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (messenger.canGoBack) {
        messenger.back();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [messenger]);

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: theme.bg }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={keyboardVerticalOffset}>
      <View style={{ flex: 1, paddingTop: insets?.top ?? 0, paddingBottom: insets?.bottom ?? 0 }}>
        {/* Keyed by route: navigating away (Back) resets it. */}
        <SupportErrorBoundary key={JSON.stringify(messenger.route)} fallback={(reset) => (
            <WithHeader onClose={onClose}>
              <ErrorState onRetry={reset} />
            </WithHeader>
          )}>
          <Screens onClose={onClose} />
        </SupportErrorBoundary>
      </View>
    </KeyboardAvoidingView>
  );
}

/** Full-screen help center + chat. Put it in a screen of your navigator, or use <SupportModal/>. */
export function SupportScreen({ theme, ...props }: SupportScreenProps) {
  return (
    <ThemeOverridesContext.Provider value={theme ?? {}}>
      <Body {...props} />
    </ThemeOverridesContext.Provider>
  );
}

/** Modal controlled by LiveChat.open()/close() and useMessenger(). Mount once near your app root. */
export function SupportModal(props: Omit<SupportScreenProps, "onClose">) {
  const messenger = useMessenger();
  return (
    <Modal visible={messenger.isOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => (messenger.canGoBack ? messenger.back() : messenger.close())}>
      <SupportScreen {...props} onClose={messenger.close} insets={{ bottom: Platform.OS === "ios" ? 20 : 0, ...props.insets }} />
    </Modal>
  );
}

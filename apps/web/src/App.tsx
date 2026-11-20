import {
  MutationCache,
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { type ReactElement, useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { AskProvider } from "./api/ask";
import { ApiError, api, isApiError } from "./api/client";
import { ListenProvider } from "./api/listen";
import { LiveProvider } from "./api/live";
import { qk, useMe } from "./api/queries";
import { SessionProvider, useSession } from "./api/session";
import { RequireConsent } from "./components/RequireConsent";
import { Shell } from "./components/Shell";
import { ToastProvider, useToast } from "./components/Toast";
import { ErrorNote, Loading, useErrorText } from "./components/ui";
import { I18nProvider, useI18n } from "./i18n";
import { AuthScreen } from "./pages/Auth";
import { ConsentPage } from "./pages/Consent";
import { ConversationPage } from "./pages/Conversation";
import { DayPage, DaysPage } from "./pages/Days";
import { DevicesPage } from "./pages/Devices";
import { MemoriesPage } from "./pages/Memories";
import { MorePage } from "./pages/More";
import { NotFoundPage } from "./pages/NotFound";
import { SearchPage } from "./pages/Search";
import { DataSettings } from "./pages/settings/Data";
import { SettingsLayout } from "./pages/settings/Layout";
import { NoticesSettings } from "./pages/settings/Notices";
import { PipelineSettingsPage } from "./pages/settings/Pipeline";
import { PrivacySettingsPage } from "./pages/settings/Privacy";
import { ProvidersSettings } from "./pages/settings/Providers";
import { TimelinePage } from "./pages/Timeline";

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: false,
        // Client errors will not fix themselves on retry; network blips and 5xx might.
        retry: (count, err) =>
          !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
      },
      mutations: { retry: false },
    },
    mutationCache: new MutationCache(),
  });
}

/**
 * Every failed mutation surfaces as a toast unless it opts out with `meta: { inline: true }`
 * because the form shows the error next to the field instead.
 */
function MutationErrorToasts() {
  const qc = useQueryClient();
  const toast = useToast();
  const errorText = useErrorText();
  useEffect(
    () =>
      qc.getMutationCache().subscribe((event) => {
        if (event.type !== "updated" || event.action.type !== "error") return;
        if (event.mutation.meta?.inline) return;
        if (isApiError(event.action.error, "unauthorized")) return;
        toast.show(errorText(event.action.error), "error");
      }),
    [qc, toast, errorText],
  );
  return null;
}

function AdoptAccountLocale() {
  const me = useMe();
  const { adoptAccountLocale } = useI18n();
  const locale = me.data?.user.locale;
  useEffect(() => {
    if (locale) adoptAccountLocale(locale);
  }, [locale, adoptAccountLocale]);
  return null;
}

function Splash() {
  return (
    <div className="splash">
      <Loading />
    </div>
  );
}

function AuthGate() {
  const session = useSession();
  const status = useQuery({ queryKey: qk.authStatus, queryFn: api.authStatus });
  const ready = !!status.data && !status.data.setupRequired && !session.signedOut;
  const me = useQuery({ queryKey: qk.me, queryFn: api.me, retry: false, enabled: ready });

  if (status.isPending) return <Splash />;
  if (status.error) {
    return (
      <div className="splash">
        <ErrorNote error={status.error} onRetry={() => void status.refetch()} />
      </div>
    );
  }
  if (status.data.setupRequired) return <AuthScreen mode="setup" registrationOpen={false} />;
  if (session.signedOut || isApiError(me.error, "unauthorized")) {
    return <AuthScreen mode="login" registrationOpen={status.data.registrationOpen} />;
  }
  if (me.isPending) return <Splash />;
  if (me.error) {
    return (
      <div className="splash">
        <ErrorNote error={me.error} onRetry={() => void me.refetch()} />
      </div>
    );
  }
  return (
    <LiveProvider>
      <AskProvider>
        <ListenProvider>
          <AdoptAccountLocale />
          <AppRoutes />
        </ListenProvider>
      </AskProvider>
    </LiveProvider>
  );
}

/** Screens about captured data and capture devices sit behind the consent gate. */
const gated = (el: ReactElement) => <RequireConsent>{el}</RequireConsent>;

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={gated(<DaysPage />)} />
        <Route path="days/:date" element={gated(<DayPage />)} />
        <Route path="timeline" element={gated(<TimelinePage />)} />
        <Route path="conversations/:id" element={gated(<ConversationPage />)} />
        <Route path="memories" element={gated(<MemoriesPage />)} />
        <Route path="search" element={gated(<SearchPage />)} />
        <Route path="ask" element={gated(<SearchPage />)} />
        <Route path="devices" element={gated(<DevicesPage />)} />
        <Route path="more" element={<MorePage />} />
        <Route path="consent" element={<ConsentPage />} />
        <Route path="settings" element={<SettingsLayout />}>
          <Route index element={<Navigate to="providers" replace />} />
          <Route path="providers" element={<ProvidersSettings />} />
          <Route path="privacy" element={<PrivacySettingsPage />} />
          <Route path="pipeline" element={<PipelineSettingsPage />} />
          <Route path="data" element={<DataSettings />} />
          <Route path="notices" element={<NoticesSettings />} />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export function App() {
  const [queryClient] = useState(createQueryClient);
  return (
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <SessionProvider>
            <MutationErrorToasts />
            <BrowserRouter>
              <AuthGate />
            </BrowserRouter>
          </SessionProvider>
        </ToastProvider>
      </QueryClientProvider>
    </I18nProvider>
  );
}

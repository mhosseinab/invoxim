import {
  mailboxStartResponseSchema,
  type OnboardingResponse,
  onboardingResponseSchema,
  type ProfileView,
  profileViewSchema,
  publicConfigSchema,
} from "@invoxim/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { BrandMark } from "../icons";
import {
  assertPrivateIdentity,
  PrivateLoadError,
  readPrivate,
} from "../private/api";
import {
  confirmActor,
  googleAuthorization,
  identityFailure,
  sendOnboarding,
} from "./api";
import { onboardingCopy as text } from "./copy";
import { ImportProgress } from "./progress";
import { ReviewImport } from "./review";

type Workspace = { profile: ProfileView; data: OnboardingResponse };
export function OnboardingPage({
  displayName = text.pageInvoxim,
}: {
  displayName?: string;
}) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [loginReady, setLoginReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [chooseMailbox, setChooseMailbox] = useState(false);
  const [selected, setSelected] = useState(
    () => new URLSearchParams(location.search).get("connectionId") ?? "",
  );
  const [acceptedRunId, setAcceptedRunId] = useState<string | null>(null);
  const [showReview, setShowReview] = useState(
    location.pathname === "/onboarding/review",
  );
  const controller = useRef<AbortController | null>(null);
  const action = useRef<AbortController | null>(null);
  const main = useRef<HTMLElement | null>(null);
  const focusedReturn = useRef(false);
  const load = useCallback(
    async (background = false) => {
      controller.current?.abort();
      const request = new AbortController();
      controller.current = request;
      if (!background) {
        setLoading(true);
        setWorkspace(null);
      }
      setError("");
      try {
        const profile = await readPrivate(
          "/api/me",
          profileViewSchema,
          request.signal,
        );
        const query = selected
          ? `?${new URLSearchParams({ connectionId: selected })}`
          : "";
        const data = await readPrivate(
          `/api/onboarding${query}`,
          onboardingResponseSchema,
          request.signal,
        );
        await assertPrivateIdentity(profile.user.id, request.signal);
        if (data.login.email !== profile.user.email)
          throw new PrivateLoadError(401);
        if (!request.signal.aborted) {
          setWorkspace({ profile, data });
          setLoginReady(false);
        }
      } catch (failure) {
        if (!request.signal.aborted) {
          if (
            failure instanceof PrivateLoadError &&
            (failure.status === 401 || failure.status === 403)
          ) {
            setWorkspace(null);
            setAcceptedRunId(null);
            setError(text.expired);
            try {
              const config = await readPrivate(
                "/api/public-config",
                publicConfigSchema,
                request.signal,
              );
              if (!request.signal.aborted) setLoginReady(config.loginEnabled);
            } catch {
              setLoginReady(false);
            }
          } else setError(text.unavailable);
        }
      } finally {
        if (!request.signal.aborted) setLoading(false);
      }
    },
    [selected],
  );
  const identityChanged = useCallback(() => {
    action.current?.abort();
    setBusy(false);
    setAcceptedRunId(null);
    setShowReview(false);
    void load();
  }, [load]);
  const refresh = useCallback(() => {
    void load(true);
  }, [load]);
  useEffect(() => {
    void load();
    return () => controller.current?.abort();
  }, [load]);
  useEffect(() => {
    const foreground = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", foreground);
    window.addEventListener("pageshow", foreground);
    document.addEventListener("visibilitychange", foreground);
    return () => {
      window.removeEventListener("focus", foreground);
      window.removeEventListener("pageshow", foreground);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [refresh]);
  useEffect(() => {
    const returned = new URLSearchParams(location.search).get("mailbox");
    if (
      !workspace ||
      loading ||
      focusedReturn.current ||
      !["connected", "cancelled", "denied"].includes(returned ?? "")
    )
      return;
    const heading = main.current?.querySelector<HTMLElement>("h1");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
      focusedReturn.current = true;
    }
  }, [workspace, loading]);
  const progress = workspace?.data.progress;
  useEffect(() => {
    if (!progress || progress.historyComplete) return;
    const timer = window.setInterval(refresh, 15000);
    return () => window.clearInterval(timer);
  }, [progress, refresh]);
  useEffect(() => () => action.current?.abort(), []);
  async function authorize(connectionId?: string) {
    if (!workspace || busy) return;
    const actor = workspace.profile.user.id;
    const request = new AbortController();
    action.current = request;
    setBusy(true);
    setError("");
    try {
      await confirmActor(actor, request.signal);
      const result = mailboxStartResponseSchema.safeParse(
        await sendOnboarding(
          "/api/connections/mailbox/gmail/start",
          connectionId ? { connectionId } : {},
          request.signal,
        ),
      );
      if (!result.success) throw new Error("Invalid authorization response");
      await confirmActor(actor, request.signal);
      if (!request.signal.aborted)
        location.assign(googleAuthorization(result.data.authorizationUrl));
    } catch (failure) {
      if (!request.signal.aborted) {
        if (identityFailure(failure)) identityChanged();
        else setError(text.providerUnavailable);
      }
    } finally {
      if (!request.signal.aborted) setBusy(false);
    }
  }
  async function login() {
    if (busy || !loginReady) return;
    const request = new AbortController();
    action.current = request;
    setBusy(true);
    try {
      const result = await sendOnboarding(
        "/api/auth/sign-in/social",
        { provider: "google" },
        request.signal,
      );
      if (
        !result ||
        typeof result !== "object" ||
        !("url" in result) ||
        typeof result.url !== "string"
      )
        throw new Error("Invalid login response");
      if (!request.signal.aborted)
        location.assign(googleAuthorization(result.url));
    } catch {
      if (!request.signal.aborted) setError(text.pageSignInCouldNotBeStarted);
    } finally {
      if (!request.signal.aborted) setBusy(false);
    }
  }
  const data = workspace?.data;
  const connection =
    data?.connections.find(
      (item) => item.id === (selected || data.view.connectionId),
    ) ?? data?.connections[0];
  const canConnect =
    data?.capabilities.mailboxProviders.includes("gmail") === true;
  const callback = new URLSearchParams(location.search).get("mailbox");
  const callbackNotice =
    callback === "cancelled" || callback === "denied"
      ? text.pageMailboxAuthorizationWasNotCompletedNothing
      : null;
  return (
    <div className="onboarding-app private-app">
      <a className="skip" href="#content">
        {text.pageSkipToContent}
      </a>
      <header className="topbar">
        <a className="wordmark" href="/">
          <BrandMark />
          {displayName}
        </a>
        <nav aria-label={text.pageWorkspaceLinks}>
          <a href="/home">{text.pageHome}</a>
          <a href="/purchases">{text.pagePurchases}</a>
          <a href="/#privacy">{text.pagePrivacy}</a>
        </nav>
      </header>
      <main ref={main} id="content" className="onboarding-page">
        {loading && <p role="status">{text.loading}</p>}
        {error && <p role="alert">{error}</p>}
        {!workspace && !loading && (
          <section className="private-panel">
            <h1>{text.loginTitle}</h1>
            {loginReady && (
              <button
                className="primary"
                type="button"
                disabled={busy}
                onClick={() => void login()}
              >
                {text.pageContinueWithGoogle}
              </button>
            )}
            <a href="/demo">{text.pageExploreTheExample}</a>
            <button type="button" onClick={() => void load()}>
              {text.pageRetry}
            </button>
          </section>
        )}
        {workspace && data && (
          <>
            <p>
              {text.signedInPrefix}
              <span>{workspace.profile.user.email}</span>
              {text.loginMailboxSeparation}
            </p>
            {callbackNotice && <p className="notice">{callbackNotice}</p>}
            {chooseMailbox || !connection ? (
              <section className="private-panel">
                <h1>{text.connectTitle}</h1>
                <p>{text.pageGmailAuthorizationGrantsBroadReadAccess}</p>
                {data.connections.length > 0 && (
                  <>
                    <label>
                      {text.pageReceiptInbox}
                      <select
                        value={selected || connection?.id || ""}
                        onChange={(event) => setSelected(event.target.value)}
                      >
                        {data.connections.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.address}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        setChooseMailbox(false);
                        setShowReview(true);
                      }}
                    >
                      {text.pageReviewSelectedInbox}
                    </button>
                  </>
                )}
                {canConnect && data.connections.length < data.mailboxLimit ? (
                  <button
                    className="primary"
                    type="button"
                    disabled={busy}
                    onClick={() => void authorize()}
                  >
                    {text.pageConnectGmailInbox}
                  </button>
                ) : (
                  <p>
                    {canConnect
                      ? text.pageYourMailboxLimitHasBeenReached
                      : text.noProvider}
                  </p>
                )}
                <a href="/connections">{text.pageViewConnectionStatus}</a>
                {data.view.readyRecordCount > 0 && (
                  <a href="/purchases">{text.pageViewExistingRecords}</a>
                )}
              </section>
            ) : !connection.scopeReady || connection.state !== "connected" ? (
              <section className="private-panel">
                <h1>{text.pageReconnectYourReceiptInbox}</h1>
                <p>
                  {connection.address}{" "}
                  {text.pageNeedsAuthorizationWithTheRequiredRead}
                </p>
                {canConnect && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void authorize(connection.id)}
                  >
                    {text.reconnectPrefix}
                    {connection.address}
                  </button>
                )}
                <button type="button" onClick={() => setChooseMailbox(true)}>
                  {text.pageChooseAnotherInbox}
                </button>
                <a href="/purchases">{text.pageViewExistingRecords}</a>
              </section>
            ) : showReview || (!data.progress && !acceptedRunId) ? (
              <ReviewImport
                key={`${workspace.profile.user.id}:${connection.id}`}
                data={data}
                profile={workspace.profile}
                connectionId={connection.id}
                onStarted={(runId) => {
                  setAcceptedRunId(runId);
                  setShowReview(false);
                  refresh();
                }}
                onRefresh={refresh}
                onIdentityChanged={identityChanged}
                onChooseMailbox={() => setChooseMailbox(true)}
              />
            ) : (
              <>
                <ImportProgress
                  data={data}
                  acceptedRunId={acceptedRunId}
                  onRefresh={refresh}
                />
                <button type="button" onClick={() => setShowReview(true)}>
                  {text.pageReviewProcessingDetails}
                </button>
                <button type="button" onClick={() => setChooseMailbox(true)}>
                  {text.pageChooseAnotherInbox}
                </button>
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}

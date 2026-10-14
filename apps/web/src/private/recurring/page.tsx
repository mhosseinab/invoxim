import {
  type ProfileView,
  type PurchaseCoverage,
  profileViewSchema,
  purchaseCoverageSchema,
  recurringDetailResponseSchema,
  recurringListResponseSchema,
} from "@invoxim/contracts";
import { useEffect, useRef, useState } from "react";
import { BrandMark, Icon } from "../../icons";
import {
  identityFailure,
  PrivateLoadError,
  readLoginEnabled,
  readPrivate,
  readPrivateForIdentity,
} from "../api";
import { Coverage } from "../components";
import { RecurringWorkspace } from "./workspace";

type Data = {
  profile: ProfileView;
  coverage: PurchaseCoverage;
  list?: typeof recurringListResponseSchema._output;
  detail?: typeof recurringDetailResponseSchema._output;
};
type State =
  | { kind: "loading" }
  | { kind: "ready"; data: Data }
  | { kind: "error"; status: number; loginReady: boolean };
export function RecurringPage({ displayName }: { displayName: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [revision, setRevision] = useState(0);
  const latestRevision = useRef(0);
  function refresh() {
    setState({ kind: "loading" });
    latestRevision.current += 1;
    setRevision(latestRevision.current);
  }
  useEffect(() => {
    const requestRevision = revision;
    const request = new AbortController();
    async function load() {
      try {
        const profile = await readPrivate(
          "/api/me",
          profileViewSchema,
          request.signal,
        );
        const path = window.location.pathname;
        const detailId = path.startsWith("/recurring/")
          ? decodeURIComponent(path.slice(11))
          : null;
        const data: Data = {
          profile,
          coverage: await readPrivateForIdentity(
            "/api/purchases/coverage",
            purchaseCoverageSchema,
            profile.user.id,
            request.signal,
          ),
        };
        if (detailId)
          data.detail = await readPrivateForIdentity(
            `/api/recurring/${encodeURIComponent(detailId)}`,
            recurringDetailResponseSchema,
            profile.user.id,
            request.signal,
          );
        else {
          const after = new URLSearchParams(window.location.search).get(
            "after",
          );
          data.list = await readPrivateForIdentity(
            `/api/recurring${after ? `?after=${encodeURIComponent(after)}` : ""}`,
            recurringListResponseSchema,
            profile.user.id,
            request.signal,
          );
        }
        if (
          !request.signal.aborted &&
          requestRevision === latestRevision.current
        )
          setState({ kind: "ready", data });
      } catch (error) {
        const status = error instanceof PrivateLoadError ? error.status : 502;
        let loginReady = false;
        if (identityFailure(status)) {
          loginReady = await readLoginEnabled(request.signal);
        }
        if (
          !request.signal.aborted &&
          requestRevision === latestRevision.current
        )
          setState({ kind: "error", status, loginReady });
      }
    }
    void load();
    return () => request.abort();
  }, [revision]);
  useEffect(() => {
    const revalidate = () => {
      setState({ kind: "loading" });
      latestRevision.current += 1;
      setRevision(latestRevision.current);
    };
    const visibility = () => {
      if (document.visibilityState === "visible") revalidate();
    };
    window.addEventListener("focus", revalidate);
    window.addEventListener("pageshow", revalidate);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("focus", revalidate);
      window.removeEventListener("pageshow", revalidate);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  return (
    <div className="app-frame private-app recurring-app">
      <a className="skip" href="#content">
        Skip to content
      </a>
      <aside className="sidebar" aria-label="Workspace navigation">
        <a className="wordmark" href="/home">
          <BrandMark />
          {displayName}
        </a>
        <nav className="sidebar-nav" aria-label="Main">
          <a href="/home">
            <Icon name="home" />
            Home
          </a>
          <a href="/purchases">
            <Icon name="document" />
            Purchases
          </a>
          {state.kind === "ready" && (
            <a href="/recurring" aria-current="page">
              <Icon name="document" />
              Recurring
            </a>
          )}
          <a href="/connections">
            <Icon name="connections" />
            Connections
          </a>
          <a href="/needs-attention">
            <Icon name="review" />
            Needs attention
          </a>
        </nav>
      </aside>
      <div className="app-stage">
        <header className="topbar">
          <span>Your private workspace</span>
          <button type="button" onClick={refresh}>
            Refresh recurring records
          </button>
        </header>
        <main id="content">
          <section className="demo-heading">
            <p className="eyebrow">Purchase evidence</p>
            <h1>Recurring payments</h1>
            <p>
              Track services you identify from documented payments. Estimates
              never add to recorded spending.
            </p>
          </section>
          {state.kind === "loading" && (
            <p role="status">Loading recurring records…</p>
          )}
          {state.kind === "error" && (
            <section
              className="private-panel"
              aria-label="Recurring unavailable"
            >
              <p role="alert">
                {identityFailure(state.status)
                  ? "Your workspace session needs verification. Refresh or sign in again when available."
                  : state.status === 503 || state.status === 404
                    ? "Recurring payments are unavailable in this workspace."
                    : state.status === 409
                      ? "These records changed. Refresh to review the latest evidence."
                      : "Recurring records could not be loaded. Check your connection and refresh."}
              </p>
              {state.loginReady && (
                <a href="/onboarding">Sign in with Google</a>
              )}
              <p>
                <a href="/purchases">View purchase records</a> ·{" "}
                <a href="/demo">Try an example</a>
              </p>
            </section>
          )}
          {state.kind === "ready" && (
            <>
              <Coverage coverage={state.data.coverage} />
              <RecurringWorkspace
                key={`${state.data.profile.user.id}:${revision}`}
                userId={state.data.profile.user.id}
                list={state.data.list}
                detail={state.data.detail}
                refresh={refresh}
              />
            </>
          )}
        </main>
      </div>
    </div>
  );
}

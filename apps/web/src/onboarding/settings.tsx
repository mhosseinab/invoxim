import {
  type AiSettingsResponse,
  aiSettingsRequestSchema,
  aiSettingsResponseSchema,
} from "@invoxim/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { readPrivateForIdentity } from "../private/api";
import { confirmActor, identityFailure, sendOnboarding } from "./api";
import { onboardingCopy as text } from "./copy";
export function AdvancedAi({
  actorId,
  onChanged,
  onIdentityChanged,
}: {
  actorId: string;
  onChanged: () => void;
  onIdentityChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [model, setModel] = useState<AiSettingsResponse | null>(null);
  const [providerId, setProvider] = useState("");
  const [modelId, setModelId] = useState("");
  const [key, setKey] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const controller = useRef<AbortController | null>(null);
  const loadSettings = useCallback(() => {
    controller.current?.abort();
    setModel(null);
    setAccepted(false);
    setKey("");
    const request = new AbortController();
    controller.current = request;
    void readPrivateForIdentity(
      "/api/ai/settings",
      aiSettingsResponseSchema,
      actorId,
      request.signal,
    )
      .then((value) => {
        if (request.signal.aborted) return;
        setModel(value);
        const selected =
          value.providers.find((p) => p.id === value.providerId) ??
          value.providers[0];
        setProvider(selected?.id ?? "");
        setModelId(selected?.models[0] ?? "");
      })
      .catch((error) => {
        if (!request.signal.aborted) {
          if (error.status === 401 || error.status === 403) onIdentityChanged();
          else setMessage(text.settingsAdvancedAISettingsAreUnavailableYour);
        }
      });
    return () => {
      request.abort();
      setKey("");
    };
  }, [actorId, onIdentityChanged]);
  useEffect(() => {
    if (open) return loadSettings();
  }, [open, loadSettings]);
  const selected = model?.providers.find((p) => p.id === providerId);
  async function save() {
    if (!model?.mutationToken || !selected || busy || !accepted) return;
    const body = aiSettingsRequestSchema.safeParse({
      version: model.version,
      mode: "byok",
      providerId,
      modelId,
      acceptedPolicyVersion: selected.policyVersion,
      ...(key ? { apiKey: key } : {}),
    });
    if (!body.success) {
      setMessage(text.settingsCheckTheSelectedProviderModelAnd);
      return;
    }
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setMessage("");
    try {
      await confirmActor(actorId, request.signal);
      const result = aiSettingsResponseSchema.safeParse(
        await sendOnboarding(
          "/api/ai/settings",
          body.data,
          request.signal,
          undefined,
          "PUT",
          model.mutationToken,
        ),
      );
      await confirmActor(actorId, request.signal);
      if (!result.success) throw new Error("Invalid settings response");
      if (!request.signal.aborted) {
        setModel(result.data);
        setKey("");
        setAccepted(false);
        setMessage(text.settingsSavedReviewRequired);
        onChanged();
      }
    } catch (error) {
      if (!request.signal.aborted) {
        if (identityFailure(error)) onIdentityChanged();
        else setMessage(text.settingsSettingsCouldNotBeSavedReload);
      }
    } finally {
      setKey("");
      if (!request.signal.aborted) setBusy(false);
    }
  }
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{text.settingsAdvancedAIOptional}</summary>
      <p>{text.settingsYouCanUseAnApprovedProvider}</p>
      {message && <p role="status">{message}</p>}
      <button type="button" disabled={busy} onClick={() => loadSettings()}>
        {text.settingsReloadAISettings}
      </button>
      {model && !model.mutationToken && (
        <p>{text.settingsEditingAISettingsIsUnavailableReload}</p>
      )}
      {model && selected && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={busy}>
            <legend>{text.settingsYourAIProvider}</legend>
            <label>
              {text.settingsProvider}
              <select
                value={providerId}
                onChange={(event) => {
                  const next = model.providers.find(
                    (p) => p.id === event.target.value,
                  );
                  setProvider(event.target.value);
                  setModelId(next?.models[0] ?? "");
                  setAccepted(false);
                }}
              >
                {model.providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {text.settingsModel}
              <select
                value={modelId}
                onChange={(event) => {
                  setModelId(event.target.value);
                  setAccepted(false);
                }}
              >
                {selected.models.map((id) => (
                  <option key={id}>{id}</option>
                ))}
              </select>
            </label>
            <label>
              {text.settingsAIAPIKey}
              <input
                type="password"
                autoComplete="off"
                value={key}
                onChange={(event) => setKey(event.target.value)}
              />
            </label>
            <p>
              {model.keyConfigured
                ? text.settingsAnEncryptedKeyIsConfiguredLeave
                : text.settingsKeyRequired}
            </p>
            <p>
              {text.policyRevisionPrefix}
              {selected.policyVersion}
              {text.settingsNoticeReferences} {selected.noticeRefs.join(", ")}
              {text.settingsReadTheFullProcessingNoticesIn}
            </p>
            <label>
              <input
                type="checkbox"
                checked={accepted}
                onChange={(event) => setAccepted(event.target.checked)}
              />
              {text.settingsUseThisProviderAndPolicyRevision}
            </label>
            <button type="submit" disabled={!accepted || !model.mutationToken}>
              {text.settingsSaveAIChoice}
            </button>
          </fieldset>
        </form>
      )}
      {model && !selected && (
        <p>{text.settingsNoApprovedAIProviderIsConfigured}</p>
      )}
    </details>
  );
}

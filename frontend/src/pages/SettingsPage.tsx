import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ArrowLeft from 'lucide-react/dist/esm/icons/arrow-left.js';
import Bot from 'lucide-react/dist/esm/icons/bot.js';
import Building2 from 'lucide-react/dist/esm/icons/building-2.js';
import CheckCircle2 from 'lucide-react/dist/esm/icons/check-circle-2.js';
import Copy from 'lucide-react/dist/esm/icons/copy.js';
import FolderInput from 'lucide-react/dist/esm/icons/folder-input.js';
import KeyRound from 'lucide-react/dist/esm/icons/key-round.js';
import LinkIcon from 'lucide-react/dist/esm/icons/link.js';
import Plug from 'lucide-react/dist/esm/icons/plug.js';
import RotateCcw from 'lucide-react/dist/esm/icons/rotate-ccw.js';
import Save from 'lucide-react/dist/esm/icons/save.js';
import Shield from 'lucide-react/dist/esm/icons/shield.js';
import { resolveWorkspaceContext } from '../lib/workspace';
import ViolemaLogo from '../components/ViolemaLogo';

type Provider = 'anthropic' | 'openai' | 'openrouter' | 'mistral' | 'minimax';
type IntegrationProvider = 'github' | 'linear' | 'notion' | 'stripe' | 'hubspot' | 'airtable' | 'figma' | 'vercel';
type IntegrationCredentialField = 'token' | 'apiKey' | 'secretKey';
type Profile = 'micro' | 'default' | 'hard' | 'critical' | 'ops' | 'memory_text' | 'memory_code';
type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
type AutoGraduationProfileId = 'cautious' | 'balanced' | 'fast_learning';
type WorkflowArchetypeId = 'briefing' | 'research' | 'analysis' | 'ops' | 'general';
type FolderDropLaneState = 'not_configured' | 'drive_not_connected' | 'no_library_yet' | 'needs_share' | 'unavailable' | 'active';

interface ProviderStatus {
  configured: boolean;
  maskedToken?: string;
  workspaceConfigured?: boolean;
  serverConfigured?: boolean;
  activeSource?: 'workspace_token' | 'server_token' | 'none';
  activeSourceLabel?: string;
}

interface IntegrationFieldStatus {
  configured: boolean;
  maskedValue?: string;
  workspaceConfigured?: boolean;
  serverConfigured?: boolean;
}

interface IntegrationStatus {
  configured: boolean;
  workspaceConfigured?: boolean;
  serverConfigured?: boolean;
  activeSource?: 'workspace_credentials' | 'server_credentials' | 'none';
  activeSourceLabel?: string;
  fields: Partial<Record<IntegrationCredentialField, IntegrationFieldStatus>>;
}

interface ModelOverride {
  provider?: Provider;
  model?: string;
  baseUrl?: string;
  reasoningEffort?: ReasoningEffort;
}

interface SettingsPayload {
  workspaceId: string;
  settings: {
    workspaceId: string;
    updatedAt?: string;
    providers: Record<Provider, ProviderStatus>;
    integrations: Record<IntegrationProvider, IntegrationStatus>;
    modelOverrides: Partial<Record<Profile, ModelOverride>>;
    agentStudio?: {
      autoGraduationProfiles?: Record<string, string>;
      autoRollbackEnabled?: boolean;
      autoRollbackWeaknessThreshold?: number;
      autoRollbackMomentumThreshold?: number;
    };
  };
  modelRouting: Record<string, {
    provider: string;
    model: string;
    configured: boolean;
    tool_loop_compatible: boolean;
    source?: 'server_default' | 'workspace_override' | 'workspace_token';
    source_label?: string;
    base_url?: string;
    reasoning_effort?: ReasoningEffort;
  }>;
}

interface FolderDropStatus {
  laneState: FolderDropLaneState;
  readerEmail: string | null;
  rootFolderId: string | null;
  manualShare?: boolean;
  /** Server-supplied next step for customer-side preconditions (e.g. connect Google Drive). */
  nextAction?: { label: string; route: string };
}

async function readFolderDropResponse(response: Response, fallbackMessage: string): Promise<FolderDropStatus> {
  let payload: (Partial<FolderDropStatus> & { error?: string }) | null = null;
  try {
    payload = await response.json() as Partial<FolderDropStatus> & { error?: string };
  } catch {
    // The status code still controls the branch; use the bounded local copy.
  }
  if (!response.ok) {
    // A manual-share-required 409 is an expected, actionable lane state. Keep
    // the reader address and folder id so the callout can render instead of
    // throwing them away with a generic error.
    if (payload?.manualShare && payload.laneState === 'needs_share') {
      return payload as FolderDropStatus;
    }
    throw new Error(payload?.error || fallbackMessage);
  }
  if (!payload?.laneState) throw new Error(fallbackMessage);
  return payload as FolderDropStatus;
}

interface ProviderTestState {
  tone: 'success' | 'error' | 'idle';
  message?: string;
  testing?: boolean;
}

interface ProfileTestState {
  tone: 'success' | 'error' | 'idle';
  message?: string;
  testing?: boolean;
}

interface IntegrationTestState {
  tone: 'success' | 'error' | 'idle';
  message?: string;
  testing?: boolean;
}

const PROVIDER_COPY: Record<Provider, { label: string; help: string }> = {
  anthropic: { label: 'Anthropic', help: 'Used for the default and critical reasoning lanes by default.' },
  openai: { label: 'OpenAI', help: 'Used for micro and hard reasoning lanes by default.' },
  openrouter: { label: 'OpenRouter', help: 'Optional broad model access when a workspace wants non-default routing.' },
  mistral: { label: 'Mistral', help: 'Used for memory and embedding workloads.' },
  minimax: { label: 'MiniMax', help: 'Optional direct provider for Anthropic-compatible routing.' },
};

const INTEGRATION_COPY: Array<{
  id: IntegrationProvider;
  label: string;
  field: IntegrationCredentialField;
  fieldLabel: string;
  placeholder: string;
  help: string;
  use: string;
}> = [
  {
    id: 'github',
    label: 'GitHub',
    field: 'token',
    fieldLabel: 'Personal access token',
    placeholder: 'ghp_…',
    help: 'Repos, issues, PRs, code context, and engineering follow-through.',
    use: 'Engineering workflows',
  },
  {
    id: 'linear',
    label: 'Linear',
    field: 'apiKey',
    fieldLabel: 'API key',
    placeholder: 'lin_api_…',
    help: 'Issues, project status, sprint updates, and execution tracking.',
    use: 'Product ops',
  },
  {
    id: 'notion',
    label: 'Notion',
    field: 'token',
    fieldLabel: 'Internal integration secret',
    placeholder: 'secret_…',
    help: 'Docs, knowledge bases, project notes, and weekly update source material.',
    use: 'Knowledge work',
  },
  {
    id: 'stripe',
    label: 'Stripe',
    field: 'secretKey',
    fieldLabel: 'Secret key',
    placeholder: 'sk_live_… or sk_test_…',
    help: 'Revenue, billing, churn, failed payments, and founder metric reports.',
    use: 'Revenue intelligence',
  },
  {
    id: 'hubspot',
    label: 'HubSpot',
    field: 'token',
    fieldLabel: 'Private app token',
    placeholder: 'pat-…',
    help: 'CRM context, leads, accounts, follow-ups, and GTM reporting.',
    use: 'CRM',
  },
  {
    id: 'airtable',
    label: 'Airtable',
    field: 'token',
    fieldLabel: 'Personal access token',
    placeholder: 'pat…',
    help: 'Lightweight databases, ops trackers, CRM tables, and custom workflow data.',
    use: 'Ops data',
  },
  {
    id: 'figma',
    label: 'Figma',
    field: 'token',
    fieldLabel: 'Personal access token',
    placeholder: 'figd_…',
    help: 'Design file context, product reviews, and launch asset workflows.',
    use: 'Design ops',
  },
  {
    id: 'vercel',
    label: 'Vercel',
    field: 'token',
    fieldLabel: 'Access token',
    placeholder: 'vercel token',
    help: 'Deployments, project status, release checks, and production readiness signals.',
    use: 'Deployments',
  },
];

const PROFILE_COPY: Array<{ id: Profile; label: string; help: string }> = [
  { id: 'micro', label: 'Micro', help: 'Cheap text work and utility routing.' },
  { id: 'default', label: 'Default', help: 'Normal chat, research, and core coordination.' },
  { id: 'hard', label: 'Hard', help: 'Deeper reasoning and technical work.' },
  { id: 'critical', label: 'Critical', help: 'High-assurance review and sensitive tasks.' },
  { id: 'ops', label: 'Ops', help: 'Operational and tool-heavy workflows.' },
  { id: 'memory_text', label: 'Memory text', help: 'Workspace memory embeddings.' },
  { id: 'memory_code', label: 'Memory code', help: 'Code-specific embedding lane.' },
];

const REASONING_OPTIONS: ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const PROVIDER_OPTIONS: Provider[] = ['anthropic', 'openai', 'openrouter', 'mistral', 'minimax'];
const INTEGRATION_OPTIONS = INTEGRATION_COPY.map((item) => item.id);
const WORKFLOW_ARCHETYPES: Array<{ id: WorkflowArchetypeId; label: string; help: string }> = [
  { id: 'briefing', label: 'Briefing and delivery', help: 'Research-heavy workflows that still need polished output and final delivery.' },
  { id: 'research', label: 'Research and monitoring', help: 'Source gathering, scanning, and current-state intelligence work.' },
  { id: 'analysis', label: 'Analysis and diagnosis', help: 'Comparison, synthesis, diagnosis, and reasoning-heavy workflows.' },
  { id: 'ops', label: 'Ops and follow-through', help: 'Alerts, follow-through loops, and delivery-heavy recurring work.' },
  { id: 'general', label: 'General execution', help: 'Mixed work that does not fit one dominant archetype.' },
];
const AUTO_GRADUATION_PROFILES: Array<{
  id: AutoGraduationProfileId;
  label: string;
  help: string;
}> = [
  { id: 'cautious', label: 'Cautious', help: 'Graduates only after stronger evidence. Better for high-stakes or noisy workflows.' },
  { id: 'balanced', label: 'Balanced', help: 'Good default. Promotes clear winners without overreacting to short runs.' },
  { id: 'fast_learning', label: 'Fast learning', help: 'Promotes sooner. Better when speed matters more than avoiding reversals.' },
];

// User-facing status language for each folder-drop lane state. Verbatim —
// this text is contract-tested, and the operator reads it as the honest
// state of the lane, not a summary of it.
const FOLDER_DROP_LANE_COPY: Record<FolderDropLaneState, string> = {
  not_configured: "Folder drop isn't configured on this server yet.",
  drive_not_connected: 'Connect Google Drive first. Violema creates your Violema Library folder there, and folder drop reads from it.',
  no_library_yet:
    "Your Violema Library folder doesn't exist yet. It's created the first time a mission files something there — run a mission with a library step, then come back.",
  needs_share: 'Share your Violema Library folder with the reader address below, then verify.',
  unavailable: 'Google Drive or the Violema reader is temporarily unavailable. Retry later; re-sharing the folder will not fix this incident.',
  active: 'Violema can see files you drop in your Violema Library folder.',
};

const FOLDER_DROP_LANE_LABEL: Record<FolderDropLaneState, string> = {
  not_configured: 'Not configured',
  drive_not_connected: 'Connect Google Drive',
  no_library_yet: 'Not created yet',
  needs_share: 'Needs share',
  unavailable: 'Unavailable',
  active: 'Active',
};

function createEmptyIntegrationInputState() {
  return Object.fromEntries(INTEGRATION_OPTIONS.map((provider) => [provider, ''])) as Record<IntegrationProvider, string>;
}

function createEmptyIntegrationClearState() {
  return Object.fromEntries(INTEGRATION_OPTIONS.map((provider) => [provider, false])) as Record<IntegrationProvider, boolean>;
}

function createEmptyIntegrationTestState() {
  return Object.fromEntries(INTEGRATION_OPTIONS.map((provider) => [provider, { tone: 'idle' }])) as Record<IntegrationProvider, IntegrationTestState>;
}

export default function SettingsPage() {
  const navigate = useNavigate();
  const workspace = useMemo(() => resolveWorkspaceContext(), []);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [data, setData] = useState<SettingsPayload | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  const [providerInputs, setProviderInputs] = useState<Record<Provider, string>>({
    anthropic: '',
    openai: '',
    openrouter: '',
    mistral: '',
    minimax: '',
  });
  const [providerClears, setProviderClears] = useState<Record<Provider, boolean>>({
    anthropic: false,
    openai: false,
    openrouter: false,
    mistral: false,
    minimax: false,
  });
  const [integrationInputs, setIntegrationInputs] = useState<Record<IntegrationProvider, string>>(createEmptyIntegrationInputState);
  const [integrationClears, setIntegrationClears] = useState<Record<IntegrationProvider, boolean>>(createEmptyIntegrationClearState);
  const [modelOverrides, setModelOverrides] = useState<Partial<Record<Profile, ModelOverride>>>({});
  const [providerTests, setProviderTests] = useState<Record<Provider, ProviderTestState>>({
    anthropic: { tone: 'idle' },
    openai: { tone: 'idle' },
    openrouter: { tone: 'idle' },
    mistral: { tone: 'idle' },
    minimax: { tone: 'idle' },
  });
  const [integrationTests, setIntegrationTests] = useState<Record<IntegrationProvider, IntegrationTestState>>(createEmptyIntegrationTestState);
  const [profileTests, setProfileTests] = useState<Record<Profile, ProfileTestState>>({
    micro: { tone: 'idle' },
    default: { tone: 'idle' },
    hard: { tone: 'idle' },
    critical: { tone: 'idle' },
    ops: { tone: 'idle' },
    memory_text: { tone: 'idle' },
    memory_code: { tone: 'idle' },
  });
  const [agentStudioSettings, setAgentStudioSettings] = useState<{
    autoGraduationProfiles: Partial<Record<WorkflowArchetypeId, AutoGraduationProfileId>>;
    autoRollbackEnabled: boolean;
    autoRollbackWeaknessThreshold: number;
    autoRollbackMomentumThreshold: number;
  }>({
    autoGraduationProfiles: {},
    autoRollbackEnabled: false,
    autoRollbackWeaknessThreshold: 12,
    autoRollbackMomentumThreshold: 6,
  });
  const [businessSummary, setBusinessSummary] = useState('');
  const [businessKeywords, setBusinessKeywords] = useState('');
  const [businessCompetitors, setBusinessCompetitors] = useState('');
  const [businessExclusions, setBusinessExclusions] = useState('');
  const [businessStatus, setBusinessStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [businessErrors, setBusinessErrors] = useState<string[]>([]);
  // Loading flag + a server-confirmed snapshot flag for the status pill: the
  // pill must reflect what the backend actually holds, not the live-editable
  // fields above (which lag or lead the server between load and Save).
  const [businessLoading, setBusinessLoading] = useState(true);
  const [businessContextSet, setBusinessContextSet] = useState(false);
  // Same server-snapshot convention as the business pill above: the pill and
  // lane copy must reflect what the backend just reported, never anything
  // derived from the reader-email or URL inputs below.
  const [folderDropLoading, setFolderDropLoading] = useState(true);
  const [folderDropStatus, setFolderDropStatus] = useState<FolderDropStatus | null>(null);
  const [folderDropError, setFolderDropError] = useState<string | null>(null);
  const [folderDropVerifying, setFolderDropVerifying] = useState(false);
  const [folderDropSharing, setFolderDropSharing] = useState(false);
  const [folderDropNotice, setFolderDropNotice] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  const [folderDropCopied, setFolderDropCopied] = useState(false);
  const [libraryUrl, setLibraryUrl] = useState('');
  const [libraryUrlStatus, setLibraryUrlStatus] = useState<'idle' | 'adding' | 'added' | 'error'>('idle');
  const [libraryUrlMessage, setLibraryUrlMessage] = useState<string | null>(null);

  useEffect(() => {
    if (window.location.hash === '#business') {
      document.getElementById('business')?.scrollIntoView({ behavior: 'smooth' });
    }
  }, []);

  useEffect(() => {
    if (loading || !data || typeof window === 'undefined') return;
    const targetId = window.location.hash.replace(/^#/, '').trim();
    if (!targetId) return;
    const target = document.getElementById(targetId);
    if (!target) return;
    target.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [data, loading]);

  async function loadSettings(silent = false) {
    if (!silent) setLoading(true);
    try {
      const response = await fetch(`/api/settings?workspace_id=${encodeURIComponent(workspace.workspaceId)}&workspace_name=${encodeURIComponent(workspace.workspaceName)}`, {
        headers: {
          'X-Workspace-Id': workspace.workspaceId,
          'X-Workspace-Name': workspace.workspaceName,
        },
      });
      if (!response.ok) throw new Error('Could not load settings');
      const payload = await response.json() as SettingsPayload;
      setData(payload);
      setModelOverrides(payload.settings.modelOverrides || {});
      setAgentStudioSettings({
        autoGraduationProfiles: (payload.settings.agentStudio?.autoGraduationProfiles || {}) as Partial<Record<WorkflowArchetypeId, AutoGraduationProfileId>>,
        autoRollbackEnabled: payload.settings.agentStudio?.autoRollbackEnabled === true,
        autoRollbackWeaknessThreshold: payload.settings.agentStudio?.autoRollbackWeaknessThreshold ?? 12,
        autoRollbackMomentumThreshold: payload.settings.agentStudio?.autoRollbackMomentumThreshold ?? 6,
      });
      setProviderClears({
        anthropic: false,
        openai: false,
        openrouter: false,
        mistral: false,
        minimax: false,
      });
      setProviderInputs({
        anthropic: '',
        openai: '',
        openrouter: '',
        mistral: '',
        minimax: '',
      });
      setIntegrationInputs(createEmptyIntegrationInputState());
      setIntegrationClears(createEmptyIntegrationClearState());
      setProviderTests({
        anthropic: { tone: 'idle' },
        openai: { tone: 'idle' },
        openrouter: { tone: 'idle' },
        mistral: { tone: 'idle' },
        minimax: { tone: 'idle' },
      });
      setIntegrationTests(createEmptyIntegrationTestState());
      setProfileTests({
        micro: { tone: 'idle' },
        default: { tone: 'idle' },
        hard: { tone: 'idle' },
        critical: { tone: 'idle' },
        ops: { tone: 'idle' },
        memory_text: { tone: 'idle' },
        memory_code: { tone: 'idle' },
      });
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Could not load settings.' });
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => {
    void loadSettings();
    // Intentionally runs once on mount; loadSettings is redefined each render
    // (not memoized), so listing it here would refetch settings on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadBusinessContext() {
    setBusinessLoading(true);
    try {
      const response = await fetch(`/api/workspace/business-context?workspace_id=${encodeURIComponent(workspace.workspaceId)}&workspace_name=${encodeURIComponent(workspace.workspaceName)}`, {
        headers: {
          'X-Workspace-Id': workspace.workspaceId,
          'X-Workspace-Name': workspace.workspaceName,
        },
      });
      if (!response.ok) throw new Error('Could not load your business context');
      const payload = await response.json() as {
        workspaceId: string;
        businessContext: { summary: string; marketKeywords: string[]; competitors: string[]; exclusions?: string[] } | null;
      };
      const ctx = payload.businessContext;
      if (ctx) {
        setBusinessSummary(ctx.summary);
        setBusinessKeywords(ctx.marketKeywords.join(', '));
        setBusinessCompetitors(ctx.competitors.join(', '));
        setBusinessExclusions((ctx.exclusions || []).join(', '));
      }
      // Server-confirmed, not the live fields just above: mirrors the
      // backend's own isBusinessContextSet gate (summary + >=1 keyword).
      setBusinessContextSet(Boolean(ctx && ctx.summary.trim() && ctx.marketKeywords.length >= 1));
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Could not load your business context.' });
    } finally {
      setBusinessLoading(false);
    }
  }

  useEffect(() => {
    void loadBusinessContext();
    // Intentionally runs once on mount; loadBusinessContext is redefined each
    // render (not memoized), so listing it here would refetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadFolderDropStatus() {
    setFolderDropLoading(true);
    setFolderDropStatus(null);
    setFolderDropError(null);
    try {
      const response = await fetch(`/api/workspace/library/folder-drop?workspace_id=${encodeURIComponent(workspace.workspaceId)}&workspace_name=${encodeURIComponent(workspace.workspaceName)}`, {
        headers: {
          'X-Workspace-Id': workspace.workspaceId,
          'X-Workspace-Name': workspace.workspaceName,
        },
      });
      const payload = await readFolderDropResponse(response, 'Could not load your folder-drop status.');
      setFolderDropStatus(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not load your folder-drop status.';
      setFolderDropStatus(null);
      setFolderDropError(message);
      setNotice({ tone: 'error', message });
    } finally {
      setFolderDropLoading(false);
    }
  }

  useEffect(() => {
    void loadFolderDropStatus();
    // Intentionally runs once on mount; loadFolderDropStatus is redefined each
    // render (not memoized), so listing it here would refetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 3200);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  async function handleSave() {
    setSaving(true);
    try {
      const providerTokens = Object.fromEntries(
        PROVIDER_OPTIONS.map((provider) => [
          provider,
          providerClears[provider] ? null : providerInputs[provider].trim() || undefined,
        ]),
      );

      const integrationCredentials = Object.fromEntries(
        INTEGRATION_COPY.map((integration) => [
          integration.id,
          integrationClears[integration.id]
            ? null
            : integrationInputs[integration.id].trim()
              ? { [integration.field]: integrationInputs[integration.id].trim() }
              : undefined,
        ]),
      );

      const serializedOverrides = Object.fromEntries(
        PROFILE_COPY.map(({ id }) => {
          const current = modelOverrides[id];
          const hasValue = Boolean(current?.provider || current?.model || current?.baseUrl || current?.reasoningEffort);
          return [id, hasValue ? current : null];
        }),
      );

      const response = await fetch('/api/settings', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Workspace-Id': workspace.workspaceId,
          'X-Workspace-Name': workspace.workspaceName,
        },
        body: JSON.stringify({
          workspaceId: workspace.workspaceId,
          workspaceName: workspace.workspaceName,
          providerTokens,
          integrationCredentials,
          modelOverrides: serializedOverrides,
          agentStudio: {
            autoGraduationProfiles: agentStudioSettings.autoGraduationProfiles,
            autoRollbackEnabled: agentStudioSettings.autoRollbackEnabled,
            autoRollbackWeaknessThreshold: agentStudioSettings.autoRollbackWeaknessThreshold,
            autoRollbackMomentumThreshold: agentStudioSettings.autoRollbackMomentumThreshold,
          },
        }),
      });
      if (!response.ok) throw new Error('Could not save settings');
      const payload = await response.json() as SettingsPayload;
      setData(payload);
      setModelOverrides(payload.settings.modelOverrides || {});
      setAgentStudioSettings({
        autoGraduationProfiles: (payload.settings.agentStudio?.autoGraduationProfiles || {}) as Partial<Record<WorkflowArchetypeId, AutoGraduationProfileId>>,
        autoRollbackEnabled: payload.settings.agentStudio?.autoRollbackEnabled === true,
        autoRollbackWeaknessThreshold: payload.settings.agentStudio?.autoRollbackWeaknessThreshold ?? 12,
        autoRollbackMomentumThreshold: payload.settings.agentStudio?.autoRollbackMomentumThreshold ?? 6,
      });
      setProviderInputs({
        anthropic: '',
        openai: '',
        openrouter: '',
        mistral: '',
        minimax: '',
      });
      setIntegrationInputs(createEmptyIntegrationInputState());
      setProviderClears({
        anthropic: false,
        openai: false,
        openrouter: false,
        mistral: false,
        minimax: false,
      });
      setIntegrationClears(createEmptyIntegrationClearState());
      setNotice({ tone: 'success', message: 'Saved workspace setup.' });
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Could not save settings.' });
    } finally {
      setSaving(false);
    }
  }

  async function handleBusinessSave() {
    setBusinessStatus('saving');
    setBusinessErrors([]);
    try {
      const marketKeywords = businessKeywords.split(',').map((item) => item.trim()).filter(Boolean);
      const competitors = businessCompetitors.split(',').map((item) => item.trim()).filter(Boolean);
      const exclusions = businessExclusions.split(',').map((item) => item.trim()).filter(Boolean);

      const response = await fetch(`/api/workspace/business-context?workspace_id=${encodeURIComponent(workspace.workspaceId)}&workspace_name=${encodeURIComponent(workspace.workspaceName)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Workspace-Id': workspace.workspaceId,
          'X-Workspace-Name': workspace.workspaceName,
        },
        body: JSON.stringify({
          summary: businessSummary.trim(),
          marketKeywords,
          competitors,
          exclusions,
        }),
      });

      if (response.status === 400) {
        const payload = await response.json() as { error?: string; code?: string; details?: string[] };
        setBusinessErrors(payload.details?.length ? payload.details : [payload.error || 'Could not save your business context.']);
        setBusinessStatus('error');
        return;
      }
      if (!response.ok) throw new Error('Could not save your business context');

      const payload = await response.json() as {
        ok: boolean;
        workspaceId: string;
        businessContext: { summary: string; marketKeywords: string[]; competitors: string[]; exclusions?: string[] };
      };
      setBusinessSummary(payload.businessContext.summary);
      setBusinessKeywords(payload.businessContext.marketKeywords.join(', '));
      setBusinessCompetitors(payload.businessContext.competitors.join(', '));
      setBusinessExclusions((payload.businessContext.exclusions || []).join(', '));
      // A 200 here only happens when the backend's own validation passed
      // (non-empty summary, >=1 keyword), so the server-confirmed snapshot
      // the pill reads from can move to "set" unconditionally.
      setBusinessContextSet(true);
      setBusinessStatus('saved');
    } catch (error) {
      setBusinessErrors([error instanceof Error ? error.message : 'Could not save your business context.']);
      setBusinessStatus('error');
    }
  }

  async function handleFolderDropVerify() {
    setFolderDropVerifying(true);
    setFolderDropNotice(null);
    setFolderDropError(null);
    try {
      const response = await fetch('/api/workspace/library/folder-drop/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Workspace-Id': workspace.workspaceId,
          'X-Workspace-Name': workspace.workspaceName,
        },
        body: JSON.stringify({ workspaceId: workspace.workspaceId, workspaceName: workspace.workspaceName }),
      });
      const payload = await readFolderDropResponse(response, 'Could not verify your folder-drop lane.');
      setFolderDropStatus(payload);
      setFolderDropNotice(
        payload.laneState === 'active'
          ? { tone: 'success', message: 'Verified. Violema can see your folder now.' }
          : { tone: 'error', message: FOLDER_DROP_LANE_COPY[payload.laneState] },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not verify your folder-drop lane.';
      setFolderDropStatus(null);
      setFolderDropError(message);
      setFolderDropNotice({ tone: 'error', message });
    } finally {
      setFolderDropVerifying(false);
    }
  }

  async function handleFolderDropShare() {
    setFolderDropSharing(true);
    setFolderDropNotice(null);
    setFolderDropError(null);
    try {
      const response = await fetch('/api/workspace/library/folder-drop/share', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Workspace-Id': workspace.workspaceId,
          'X-Workspace-Name': workspace.workspaceName,
        },
        body: JSON.stringify({ workspaceId: workspace.workspaceId, workspaceName: workspace.workspaceName }),
      });
      const payload = await readFolderDropResponse(response, 'Could not share your library folder.');
      setFolderDropStatus(payload);
      if (!payload.manualShare && payload.laneState !== 'active') {
        setFolderDropNotice({ tone: 'error', message: FOLDER_DROP_LANE_COPY[payload.laneState] });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not share your library folder.';
      setFolderDropStatus(null);
      setFolderDropError(message);
      setFolderDropNotice({ tone: 'error', message });
    } finally {
      setFolderDropSharing(false);
    }
  }

  async function handleFolderDropCopyReaderEmail() {
    if (!folderDropStatus?.readerEmail) return;
    try {
      await navigator.clipboard.writeText(folderDropStatus.readerEmail);
      setFolderDropCopied(true);
      window.setTimeout(() => setFolderDropCopied(false), 1500);
    } catch {
      setFolderDropCopied(false);
    }
  }

  async function handleAddLibraryUrl() {
    const url = libraryUrl.trim();
    if (!url) return;
    setLibraryUrlStatus('adding');
    setLibraryUrlMessage(null);
    try {
      const response = await fetch('/api/workspace/library/url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Workspace-Id': workspace.workspaceId,
          'X-Workspace-Name': workspace.workspaceName,
        },
        body: JSON.stringify({ workspaceId: workspace.workspaceId, workspaceName: workspace.workspaceName, url }),
      });
      const payload = await response.json() as { ok?: boolean; fileName?: string; sourceUrl?: string; error?: string; code?: string };
      if (!response.ok || !payload.ok) {
        setLibraryUrlStatus('error');
        setLibraryUrlMessage(payload.error || 'Could not add that link to your library.');
        return;
      }
      setLibraryUrlStatus('added');
      setLibraryUrlMessage(`Added "${payload.fileName}" to your library.`);
      setLibraryUrl('');
    } catch (error) {
      setLibraryUrlStatus('error');
      setLibraryUrlMessage(error instanceof Error ? error.message : 'Could not add that link to your library.');
    }
  }

  function updateModelOverride(profile: Profile, patch: Partial<ModelOverride>) {
    setModelOverrides((current) => ({
      ...current,
      [profile]: {
        ...(current[profile] || {}),
        ...patch,
      },
    }));
  }

  function clearOverride(profile: Profile) {
    setModelOverrides((current) => {
      const next = { ...current };
      delete next[profile];
      return next;
    });
  }

  async function handleProviderTest(provider: Provider) {
    setProviderTests((current) => ({
      ...current,
      [provider]: { tone: 'idle', testing: true, message: 'Testing…' },
    }));

    try {
      const response = await fetch('/api/settings/test-provider', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Workspace-Id': workspace.workspaceId,
          'X-Workspace-Name': workspace.workspaceName,
        },
        body: JSON.stringify({
          workspaceId: workspace.workspaceId,
          workspaceName: workspace.workspaceName,
          provider,
          token: providerInputs[provider].trim() || undefined,
        }),
      });

      const payload = await response.json() as { ok?: boolean; detail?: string };
      if (!response.ok) throw new Error(payload.detail || 'Provider test failed');

      setProviderTests((current) => ({
        ...current,
        [provider]: { tone: 'success', message: payload.detail || 'Provider looks good.' },
      }));
    } catch (error) {
      setProviderTests((current) => ({
        ...current,
        [provider]: { tone: 'error', message: error instanceof Error ? error.message : 'Provider test failed.' },
      }));
    }
  }

  async function handleIntegrationTest(integration: (typeof INTEGRATION_COPY)[number]) {
    setIntegrationTests((current) => ({
      ...current,
      [integration.id]: { tone: 'idle', testing: true, message: 'Testing…' },
    }));

    try {
      const draftValue = integrationInputs[integration.id].trim();
      const response = await fetch('/api/settings/test-integration', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Workspace-Id': workspace.workspaceId,
          'X-Workspace-Name': workspace.workspaceName,
        },
        body: JSON.stringify({
          workspaceId: workspace.workspaceId,
          workspaceName: workspace.workspaceName,
          provider: integration.id,
          credentials: draftValue ? { [integration.field]: draftValue } : undefined,
        }),
      });

      const payload = await response.json() as { ok?: boolean; detail?: string };
      if (!response.ok) throw new Error(payload.detail || 'Integration test failed');

      setIntegrationTests((current) => ({
        ...current,
        [integration.id]: { tone: 'success', message: payload.detail || 'Integration looks good.' },
      }));
    } catch (error) {
      setIntegrationTests((current) => ({
        ...current,
        [integration.id]: { tone: 'error', message: error instanceof Error ? error.message : 'Integration test failed.' },
      }));
    }
  }

  async function handleProfileTest(profile: Profile) {
    setProfileTests((current) => ({
      ...current,
      [profile]: { tone: 'idle', testing: true, message: 'Testing route…' },
    }));

    try {
      const response = await fetch('/api/settings/test-profile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Workspace-Id': workspace.workspaceId,
          'X-Workspace-Name': workspace.workspaceName,
        },
        body: JSON.stringify({
          workspaceId: workspace.workspaceId,
          workspaceName: workspace.workspaceName,
          profile,
        }),
      });

      const payload = await response.json() as { ok?: boolean; detail?: string };
      if (!response.ok) throw new Error(payload.detail || 'Profile test failed');

      setProfileTests((current) => ({
        ...current,
        [profile]: { tone: 'success', message: payload.detail || 'Route looks good.' },
      }));
    } catch (error) {
      setProfileTests((current) => ({
        ...current,
        [profile]: { tone: 'error', message: error instanceof Error ? error.message : 'Profile test failed.' },
      }));
    }
  }

  return (
    <div className="min-h-screen bg-navy-950 text-white">
      {notice ? (
        <div className="pointer-events-none fixed inset-x-3 top-3 z-50 flex justify-center">
          <div className={`pointer-events-auto max-w-md rounded-2xl border px-4 py-3 shadow-[0_18px_50px_rgba(2,6,23,0.42)] backdrop-blur-md ${
            notice.tone === 'success'
              ? 'border-green-500/20 bg-green-500/12 text-green-100'
              : 'border-red-500/20 bg-red-500/12 text-red-100'
          }`}>
            <p className="text-sm font-medium">{notice.message}</p>
          </div>
        </div>
      ) : null}

      <header className="sticky top-0 z-30 border-b border-navy-800/80 bg-gradient-to-r from-navy-950/96 via-navy-900/92 to-navy-950/96 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => navigate('/dashboard')}
              className="flex items-center gap-2 rounded-xl border border-navy-700 bg-navy-900/72 px-3 py-2 text-xs text-slate-300 transition-colors hover:border-violet-600/50 hover:text-white"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Dashboard
            </button>
            <ViolemaLogo className="hidden h-10 w-[12.5rem] sm:flex" />
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Workspace setup</p>
              <h1 className="truncate text-lg font-semibold tracking-[-0.02em] text-white">Models and integrations</h1>
              <p className="mt-1 text-sm text-slate-400">Connect the accounts Violema can work inside, then tune model routing only where the work justifies it.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void loadSettings(true)}
              className="flex items-center gap-2 rounded-xl border border-navy-700 bg-navy-900/72 px-3 py-2 text-xs text-slate-300 transition-colors hover:border-violet-600/50 hover:text-white"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Refresh
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving}
              className="flex items-center gap-2 rounded-xl border border-violet-500/25 bg-violet-500/12 px-3 py-2 text-xs font-medium text-violet-100 transition-colors hover:bg-violet-500/18 disabled:opacity-60"
            >
              <Save className="h-3.5 w-3.5" />
              {saving ? 'Saving…' : 'Save setup'}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6">
        <section id="business" className="mb-6 rounded-[1.8rem] border border-navy-800/80 bg-gradient-to-b from-navy-900/72 via-navy-900/56 to-navy-950/88 p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-3xl">
              <div className="flex items-center gap-2">
                <Building2 className="h-4 w-4 text-cyan-300" />
                <div>
                  <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Workspace context</p>
                  <h2 className="text-sm font-semibold text-white">Your business</h2>
                </div>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-slate-400">
                What Violema researches for this workspace. Missions that scan the market use this — not a generic category.
              </p>
            </div>
            <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
              businessLoading
                ? 'border-navy-700 bg-navy-900 text-slate-400'
                : businessContextSet
                  ? 'border-green-500/18 bg-green-500/8 text-green-200'
                  : 'border-amber-500/18 bg-amber-500/8 text-amber-200'
            }`}>
              {businessLoading ? 'Checking…' : businessContextSet ? 'Set' : 'Not set yet'}
            </span>
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <label className="block md:col-span-2">
              <span className="mb-1.5 block text-[11px] text-slate-500">What your business is</span>
              <div className="ui-input-shell">
                <input
                  type="text"
                  value={businessSummary}
                  onChange={(event) => setBusinessSummary(event.target.value)}
                  className="w-full bg-transparent px-3 py-3 text-sm text-slate-100 outline-none"
                  placeholder="One sentence: what your business is"
                />
              </div>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[11px] text-slate-500">Market keywords</span>
              <div className="ui-input-shell">
                <input
                  type="text"
                  value={businessKeywords}
                  onChange={(event) => setBusinessKeywords(event.target.value)}
                  className="w-full bg-transparent px-3 py-3 text-sm text-slate-100 outline-none"
                  placeholder="Comma-separated: e.g. AI-powered espresso machine, smart coffee machine"
                />
              </div>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[11px] text-slate-500">Named competitors</span>
              <div className="ui-input-shell">
                <input
                  type="text"
                  value={businessCompetitors}
                  onChange={(event) => setBusinessCompetitors(event.target.value)}
                  className="w-full bg-transparent px-3 py-3 text-sm text-slate-100 outline-none"
                  placeholder="Comma-separated names or domains"
                />
              </div>
            </label>
            <label className="block md:col-span-2">
              <span className="mb-1.5 block text-[11px] text-slate-500">Topics to avoid (optional)</span>
              <div className="ui-input-shell">
                <input
                  type="text"
                  value={businessExclusions}
                  onChange={(event) => setBusinessExclusions(event.target.value)}
                  className="w-full bg-transparent px-3 py-3 text-sm text-slate-100 outline-none"
                  placeholder="Comma-separated, optional"
                />
              </div>
            </label>
          </div>

          {businessErrors.length ? (
            <div className="mt-3 rounded-xl border border-red-500/18 bg-red-500/8 px-3 py-2 text-[11px] text-red-200">
              <ul className="list-disc space-y-1 pl-4">
                {businessErrors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {businessStatus === 'saved' ? (
            <div className="mt-3 rounded-xl border border-green-500/18 bg-green-500/8 px-3 py-2 text-[11px] text-green-200">
              Saved. Missions that scan the market will use this from your next run.
            </div>
          ) : null}

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-[11px] leading-relaxed text-slate-500">
              A named competitor and a market keyword are different things — competitors are rivals, keywords are what buyers search for.
            </p>
            <button
              type="button"
              onClick={() => void handleBusinessSave()}
              disabled={businessStatus === 'saving'}
              className="flex shrink-0 items-center gap-2 rounded-xl border border-violet-500/25 bg-violet-500/12 px-3 py-2 text-xs font-medium text-violet-100 transition-colors hover:bg-violet-500/18 disabled:opacity-60"
            >
              <Save className="h-3.5 w-3.5" />
              {businessStatus === 'saving' ? 'Saving…' : 'Save business context'}
            </button>
          </div>
        </section>

        <section id="folder-drop" className="mb-6 rounded-[1.8rem] border border-navy-800/80 bg-gradient-to-b from-navy-900/72 via-navy-900/56 to-navy-950/88 p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-3xl">
              <div className="flex items-center gap-2">
                <FolderInput className="h-4 w-4 text-cyan-300" />
                <div>
                  <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Workspace library</p>
                  <h2 className="text-sm font-semibold text-white">Folder drop</h2>
                </div>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-slate-400">
                Drop files into your Violema Library folder in Google Drive and missions can read them without a manual upload.
              </p>
            </div>
            <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
              folderDropLoading
                ? 'border-navy-700 bg-navy-900 text-slate-400'
                : folderDropError
                  ? 'border-red-500/18 bg-red-500/8 text-red-200'
                : folderDropStatus?.laneState === 'active'
                  ? 'border-green-500/18 bg-green-500/8 text-green-200'
                  : folderDropStatus?.laneState === 'needs_share'
                    ? 'border-amber-500/18 bg-amber-500/8 text-amber-200'
                    : 'border-navy-700 bg-navy-900 text-slate-400'
            }`}>
              {folderDropLoading
                ? 'Checking…'
                : folderDropError
                  ? 'Unavailable'
                  : folderDropStatus
                    ? FOLDER_DROP_LANE_LABEL[folderDropStatus.laneState]
                    : 'Status unknown'}
            </span>
          </div>

          <div className="mt-4 rounded-xl border border-white/6 bg-white/[0.03] px-3 py-2.5 text-[12px] leading-relaxed text-slate-300">
            {folderDropLoading
              ? 'Checking your folder-drop status…'
              : folderDropError
                ? folderDropError
                : folderDropStatus
                  ? FOLDER_DROP_LANE_COPY[folderDropStatus.laneState]
                  : 'Folder-drop status is unavailable. Verify again to retry.'}
          </div>

          {!folderDropLoading && folderDropStatus?.readerEmail ? (
            <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-navy-700/70 bg-navy-950/42 px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Reader address</p>
                <p className="truncate text-sm text-slate-200">{folderDropStatus.readerEmail}</p>
              </div>
              <button
                type="button"
                onClick={() => void handleFolderDropCopyReaderEmail()}
                className="ui-pill ml-auto shrink-0 px-3 py-1.5 text-[10px] normal-case tracking-normal text-cyan-200"
              >
                <Copy className="h-3 w-3" />
                {folderDropCopied ? 'Copied' : 'Copy reader email'}
              </button>
            </div>
          ) : null}

          {!folderDropLoading && folderDropStatus?.laneState === 'drive_not_connected' && folderDropStatus.nextAction ? (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-cyan-500/18 bg-cyan-500/8 px-3 py-2.5">
              <p className="text-[11px] leading-relaxed text-cyan-100">
                Google Drive is not connected for this workspace yet.
              </p>
              <button
                type="button"
                onClick={() => navigate(folderDropStatus.nextAction!.route)}
                className="ui-pill shrink-0 px-3 py-1.5 text-[10px] normal-case tracking-normal text-cyan-200"
              >
                {folderDropStatus.nextAction.label}
              </button>
            </div>
          ) : null}

          {folderDropStatus?.manualShare ? (
            <div className="mt-3 rounded-xl border border-amber-500/18 bg-amber-500/8 px-3 py-2.5 text-[11px] leading-relaxed text-amber-100">
              Violema can&apos;t share this folder automatically from here. {FOLDER_DROP_LANE_COPY.needs_share}
            </div>
          ) : null}

          {folderDropNotice ? (
            <div className={`mt-3 rounded-xl border px-3 py-2 text-[11px] ${
              folderDropNotice.tone === 'success'
                ? 'border-green-500/18 bg-green-500/8 text-green-200'
                : 'border-red-500/18 bg-red-500/8 text-red-200'
            }`}>
              {folderDropNotice.message}
            </div>
          ) : null}

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-[11px] leading-relaxed text-slate-500">
              Once this lane is active, files dropped into your Violema Library folder become available to missions automatically.
            </p>
            <div className="flex shrink-0 items-center gap-2">
              {folderDropStatus?.laneState === 'needs_share' ? (
                <button
                  type="button"
                  onClick={() => void handleFolderDropShare()}
                  disabled={folderDropSharing || folderDropLoading}
                  className="ui-button-ghost px-3 py-2 text-xs disabled:opacity-60"
                >
                  <FolderInput className="h-3.5 w-3.5" />
                  {folderDropSharing ? 'Sharing…' : 'Share folder'}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => void handleFolderDropVerify()}
                disabled={folderDropVerifying || folderDropLoading}
                className="flex items-center gap-2 rounded-xl border border-violet-500/25 bg-violet-500/12 px-3 py-2 text-xs font-medium text-violet-100 transition-colors hover:bg-violet-500/18 disabled:opacity-60"
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                {folderDropVerifying ? 'Verifying…' : 'Verify'}
              </button>
            </div>
          </div>

          <div className="mt-5 border-t border-white/6 pt-4">
            <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Add a link to your library</p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
              Paste a URL and Violema pulls it into your library the same way a dropped file would.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <div className="ui-input-shell min-w-[220px] flex-1">
                <input
                  type="url"
                  value={libraryUrl}
                  onChange={(event) => setLibraryUrl(event.target.value)}
                  className="w-full bg-transparent px-3 py-3 text-sm text-slate-100 outline-none"
                  placeholder="https://…"
                />
              </div>
              <button
                type="button"
                onClick={() => void handleAddLibraryUrl()}
                disabled={libraryUrlStatus === 'adding' || !libraryUrl.trim()}
                className="flex shrink-0 items-center gap-2 rounded-xl border border-violet-500/25 bg-violet-500/12 px-3 py-2 text-xs font-medium text-violet-100 transition-colors hover:bg-violet-500/18 disabled:opacity-60"
              >
                <LinkIcon className="h-3.5 w-3.5" />
                {libraryUrlStatus === 'adding' ? 'Adding…' : 'Add'}
              </button>
            </div>
            {libraryUrlMessage ? (
              <div className={`mt-3 rounded-xl border px-3 py-2 text-[11px] ${
                libraryUrlStatus === 'added'
                  ? 'border-green-500/18 bg-green-500/8 text-green-200'
                  : 'border-red-500/18 bg-red-500/8 text-red-200'
              }`}>
                {libraryUrlMessage}
              </div>
            ) : null}
          </div>
        </section>

        {loading || !data ? (
          <div className="rounded-[1.8rem] border border-dashed border-navy-700/70 bg-navy-950/35 px-5 py-12 text-center text-sm text-slate-500">
            Loading workspace setup…
          </div>
        ) : (
          <div className="space-y-6">
            <section className="rounded-[1.8rem] border border-navy-800/80 bg-gradient-to-b from-navy-900/72 via-navy-900/56 to-navy-950/88 p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="max-w-3xl">
                  <div className="flex items-center gap-2">
                    <Plug className="h-4 w-4 text-cyan-300" />
                    <div>
                      <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Tool integrations</p>
                      <h2 className="text-sm font-semibold text-white">Connect the operating stack</h2>
                    </div>
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-slate-400">
                    Store workspace credentials for the platforms Violema needs to inspect, update, and report on. Slack stays in its dedicated setup flow; OAuth-heavy Google and Microsoft connectors should use proper OAuth instead of pasted user tokens.
                  </p>
                </div>
                <div className="rounded-2xl border border-cyan-500/16 bg-cyan-500/8 px-4 py-3 text-sm text-cyan-100">
                  {INTEGRATION_OPTIONS.filter((provider) => data.settings.integrations[provider]?.configured).length} of {INTEGRATION_OPTIONS.length} configured
                </div>
              </div>

              <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                {INTEGRATION_COPY.map((integration) => {
                  const status = data.settings.integrations[integration.id];
                  const fieldStatus = status?.fields?.[integration.field];
                  const testState = integrationTests[integration.id];
                  return (
                    <div
                      key={integration.id}
                      id={integration.id === 'stripe' ? 'integration-stripe' : undefined}
                      className="rounded-2xl border border-navy-700/70 bg-navy-950/42 p-4"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/8 bg-white/[0.04] text-[11px] font-semibold text-slate-200">
                              {integration.label.slice(0, 2).toUpperCase()}
                            </span>
                            <div>
                              <p className="text-sm font-medium text-white">{integration.label}</p>
                              <p className="text-[10px] uppercase tracking-[0.16em] text-slate-600">{integration.use}</p>
                            </div>
                          </div>
                          <p className="mt-3 text-[11px] leading-relaxed text-slate-500">{integration.help}</p>
                        </div>
                        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                          status?.activeSource === 'workspace_credentials'
                            ? 'border-cyan-500/18 bg-cyan-500/8 text-cyan-200'
                            : status?.activeSource === 'server_credentials'
                              ? 'border-violet-500/18 bg-violet-500/8 text-violet-200'
                              : 'border-navy-700 bg-navy-900 text-slate-400'
                        }`}>
                          {status?.activeSourceLabel || 'Not configured'}
                        </span>
                      </div>

                      <div className="mt-3 flex flex-wrap gap-2">
                        {fieldStatus?.workspaceConfigured ? (
                          <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">
                            Saved {fieldStatus.maskedValue || 'credential'}
                          </span>
                        ) : null}
                        {fieldStatus?.serverConfigured ? (
                          <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">
                            Server credential available
                          </span>
                        ) : null}
                        {!fieldStatus?.configured ? (
                          <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-500">
                            Needs credential
                          </span>
                        ) : null}
                      </div>

                      <div className="mt-3 space-y-2">
                        <label className="block">
                          <span className="mb-1.5 block text-[11px] text-slate-500">{integration.fieldLabel}</span>
                          <div className="ui-input-shell">
                            <input
                              type="password"
                              value={integrationInputs[integration.id]}
                              onChange={(event) => setIntegrationInputs((current) => ({ ...current, [integration.id]: event.target.value }))}
                              className="w-full bg-transparent px-3 py-3 text-sm text-slate-100 outline-none"
                              placeholder={integration.placeholder}
                            />
                          </div>
                        </label>
                        <label className="flex items-start gap-2 text-[11px] leading-relaxed text-slate-400">
                          <input
                            type="checkbox"
                            checked={integrationClears[integration.id]}
                            onChange={(event) => setIntegrationClears((current) => ({ ...current, [integration.id]: event.target.checked }))}
                            className="mt-0.5 rounded border-navy-700 bg-navy-950 text-violet-400 focus:ring-violet-500"
                          />
                          Clear workspace credential and fall back to server credential
                        </label>
                        <div className="flex justify-end">
                          <button
                            type="button"
                            onClick={() => void handleIntegrationTest(integration)}
                            disabled={integrationClears[integration.id] || testState?.testing}
                            className="ui-pill shrink-0 px-3 py-1.5 text-[10px] normal-case tracking-normal text-cyan-200 disabled:opacity-50"
                          >
                            {testState?.testing ? 'Testing…' : 'Test'}
                          </button>
                        </div>
                        {testState?.message ? (
                          <div className={`rounded-xl border px-3 py-2 text-[11px] ${
                            testState.tone === 'success'
                              ? 'border-green-500/18 bg-green-500/8 text-green-200'
                              : testState.tone === 'error'
                                ? 'border-red-500/18 bg-red-500/8 text-red-200'
                                : 'border-navy-700/70 bg-navy-950/35 text-slate-400'
                          }`}>
                            {testState.message}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            <div className="grid gap-6 xl:grid-cols-[minmax(0,0.92fr),minmax(0,1.08fr)]">
              <section className="rounded-[1.8rem] border border-navy-800/80 bg-gradient-to-b from-navy-900/72 via-navy-900/56 to-navy-950/88 p-5">
                <div className="flex items-center gap-2">
                  <KeyRound className="h-4 w-4 text-cyan-300" />
                  <div>
                    <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Model provider access</p>
                    <h2 className="text-sm font-semibold text-white">Bring your own model tokens</h2>
                  </div>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-slate-400">
                  These keys control model routing only. Use the Tool integrations section above for product platforms like GitHub, Linear, Notion, Stripe, and HubSpot.
                </p>
                <div className="mt-4 space-y-4">
                  {PROVIDER_OPTIONS.map((provider) => {
                    const status = data.settings.providers[provider];
                    return (
                      <div key={provider} className="rounded-2xl border border-navy-700/70 bg-navy-950/42 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-medium text-white">{PROVIDER_COPY[provider].label}</p>
                            <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{PROVIDER_COPY[provider].help}</p>
                          </div>
                          <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                            status.activeSource === 'workspace_token'
                              ? 'border-cyan-500/18 bg-cyan-500/8 text-cyan-200'
                              : status.activeSource === 'server_token'
                                ? 'border-violet-500/18 bg-violet-500/8 text-violet-200'
                                : status.configured
                              ? 'border-green-500/18 bg-green-500/8 text-green-200'
                              : 'border-navy-700 bg-navy-900 text-slate-400'
                          }`}>
                            {status.activeSourceLabel || (status.configured ? status.maskedToken || 'Configured' : 'Using server default')}
                          </span>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-400">
                          <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">
                            Active: {status.activeSourceLabel || 'Not configured'}
                          </span>
                          {status.workspaceConfigured ? (
                            <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">
                              Workspace token {status.maskedToken || 'saved'}
                            </span>
                          ) : null}
                          {status.serverConfigured ? (
                            <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">
                              Server token available
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-3 space-y-2">
                          <div className="ui-input-shell">
                            <input
                              type="password"
                              value={providerInputs[provider]}
                              onChange={(event) => setProviderInputs((current) => ({ ...current, [provider]: event.target.value }))}
                              className="w-full bg-transparent px-3 py-3 text-sm text-slate-100 outline-none"
                              placeholder={`Paste a ${PROVIDER_COPY[provider].label} token`}
                            />
                          </div>
                          <div className="flex items-center justify-between gap-3">
                            <label className="flex items-center gap-2 text-[11px] text-slate-400">
                              <input
                                type="checkbox"
                                checked={providerClears[provider]}
                                onChange={(event) => setProviderClears((current) => ({ ...current, [provider]: event.target.checked }))}
                                className="rounded border-navy-700 bg-navy-950 text-violet-400 focus:ring-violet-500"
                              />
                              Clear workspace override and fall back to the server token
                            </label>
                            <button
                              type="button"
                              onClick={() => void handleProviderTest(provider)}
                              disabled={providerClears[provider] || providerTests[provider].testing}
                              className="ui-pill shrink-0 px-3 py-1.5 text-[10px] normal-case tracking-normal text-cyan-200 disabled:opacity-50"
                            >
                              {providerTests[provider].testing ? 'Testing…' : 'Test'}
                            </button>
                          </div>
                          {providerTests[provider].message ? (
                            <div className={`rounded-xl border px-3 py-2 text-[11px] ${
                              providerTests[provider].tone === 'success'
                                ? 'border-green-500/18 bg-green-500/8 text-green-200'
                                : providerTests[provider].tone === 'error'
                                  ? 'border-red-500/18 bg-red-500/8 text-red-200'
                                  : 'border-navy-700/70 bg-navy-950/35 text-slate-400'
                            }`}>
                              {providerTests[provider].message}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className="rounded-[1.8rem] border border-navy-800/80 bg-gradient-to-b from-navy-900/72 via-navy-900/56 to-navy-950/88 p-5">
                <div className="flex items-center gap-2">
                  <Bot className="h-4 w-4 text-violet-300" />
                  <div>
                    <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Routing lanes</p>
                    <h2 className="text-sm font-semibold text-white">Model selection</h2>
                  </div>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-slate-400">
                  Each lane maps to a real runtime role. Override only where you have a reason. The goal is cleaner routing and lower spend, not more knobs for their own sake.
                </p>
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  {PROFILE_COPY.map((profile) => {
                    const override = modelOverrides[profile.id] || {};
                    const live = data.modelRouting[profile.id];
                    return (
                      <div key={profile.id} className="rounded-2xl border border-navy-700/70 bg-navy-950/42 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-medium text-white">{profile.label}</p>
                            <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{profile.help}</p>
                          </div>
                          <button
                            type="button"
                            onClick={() => clearOverride(profile.id)}
                            className="rounded-lg border border-navy-700/70 bg-navy-900/60 px-2 py-1 text-[10px] text-slate-400 transition-colors hover:text-white"
                          >
                            Reset
                          </button>
                        </div>
                        <div className="mt-3 rounded-xl border border-white/6 bg-white/[0.03] px-3 py-2.5 text-[11px] text-slate-400">
                          Live now: <span className="font-medium text-slate-200">{live?.provider || '—'}</span> · <span className="font-medium text-slate-200">{live?.model || '—'}</span>
                          <span className="text-slate-500"> · </span>
                          <span className="font-medium text-slate-200">{live?.source_label || 'Unknown source'}</span>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-slate-400">
                          <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">
                            {live?.tool_loop_compatible ? 'Tool loop ready' : 'Embedding lane'}
                          </span>
                          {live?.reasoning_effort ? (
                            <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">
                              Reasoning: {live.reasoning_effort}
                            </span>
                          ) : null}
                          {live?.base_url ? (
                            <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">
                              Custom base URL
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-3 space-y-2">
                          <div className="ui-input-shell">
                            <select
                              value={override.provider || ''}
                              onChange={(event) => updateModelOverride(profile.id, { provider: (event.target.value || undefined) as Provider | undefined })}
                              className="w-full bg-transparent px-3 py-3 text-sm text-slate-100 outline-none"
                            >
                              <option value="" className="bg-slate-950 text-slate-100">Use system provider</option>
                              {PROVIDER_OPTIONS.map((provider) => (
                                <option key={provider} value={provider} className="bg-slate-950 text-slate-100">{PROVIDER_COPY[provider].label}</option>
                              ))}
                            </select>
                          </div>
                          <div className="ui-input-shell">
                            <input
                              value={override.model || ''}
                              onChange={(event) => updateModelOverride(profile.id, { model: event.target.value })}
                              className="w-full bg-transparent px-3 py-3 text-sm text-slate-100 outline-none"
                              placeholder="Use system model"
                            />
                          </div>
                          <div className="grid gap-2 sm:grid-cols-2">
                            <div className="ui-input-shell">
                              <input
                                value={override.baseUrl || ''}
                                onChange={(event) => updateModelOverride(profile.id, { baseUrl: event.target.value })}
                                className="w-full bg-transparent px-3 py-3 text-sm text-slate-100 outline-none"
                                placeholder="Optional base URL"
                              />
                            </div>
                            <div className="ui-input-shell">
                              <select
                                value={override.reasoningEffort || ''}
                                onChange={(event) => updateModelOverride(profile.id, { reasoningEffort: (event.target.value || undefined) as ReasoningEffort | undefined })}
                                className="w-full bg-transparent px-3 py-3 text-sm text-slate-100 outline-none"
                              >
                                <option value="" className="bg-slate-950 text-slate-100">Default reasoning</option>
                                {REASONING_OPTIONS.map((option) => (
                                  <option key={option} value={option} className="bg-slate-950 text-slate-100">{option}</option>
                                ))}
                              </select>
                            </div>
                          </div>
                          <div className="flex items-center justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => void handleProfileTest(profile.id)}
                              disabled={profileTests[profile.id].testing}
                              className="ui-pill shrink-0 px-3 py-1.5 text-[10px] normal-case tracking-normal text-cyan-200 disabled:opacity-50"
                            >
                              {profileTests[profile.id].testing ? 'Testing route…' : 'Test lane'}
                            </button>
                          </div>
                          {profileTests[profile.id].message ? (
                            <div className={`rounded-xl border px-3 py-2 text-[11px] ${
                              profileTests[profile.id].tone === 'success'
                                ? 'border-green-500/18 bg-green-500/8 text-green-200'
                                : profileTests[profile.id].tone === 'error'
                                  ? 'border-red-500/18 bg-red-500/8 text-red-200'
                                  : 'border-navy-700/70 bg-navy-950/35 text-slate-400'
                            }`}>
                              {profileTests[profile.id].message}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            </div>

            <section className="rounded-[1.8rem] border border-navy-800/80 bg-gradient-to-b from-navy-900/72 via-navy-900/56 to-navy-950/88 p-5">
              <div className="flex items-center gap-2">
                <Shield className="h-4 w-4 text-cyan-300" />
                <div>
                  <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Agent Studio governance</p>
                  <h2 className="text-sm font-semibold text-white">Workspace Studio governance</h2>
                </div>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-slate-400">
                These defaults apply before a workflow overrides them inside Agent Studio. Use them to keep self-correction behavior consistent across the workspace.
              </p>
              <div className="mt-4 grid gap-3 md:grid-cols-3">
                <div className="rounded-2xl border border-navy-700/70 bg-navy-950/42 p-4">
                  <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Graduation posture</p>
                  <p className="mt-1 text-sm font-medium text-white">{Object.keys(agentStudioSettings.autoGraduationProfiles).length} archetype defaults set</p>
                  <p className="mt-2 text-sm leading-relaxed text-slate-400">Use this to control how aggressively strong child branches replace their parents.</p>
                </div>
                <div className="rounded-2xl border border-navy-700/70 bg-navy-950/42 p-4">
                  <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Rollback guardrail</p>
                  <p className="mt-1 text-sm font-medium text-white">{agentStudioSettings.autoRollbackEnabled ? 'Enabled' : 'Disabled'} at {agentStudioSettings.autoRollbackWeaknessThreshold}</p>
                  <p className="mt-2 text-sm leading-relaxed text-slate-400">Weakness alone is not enough. The child also has to show fresh deterioration.</p>
                </div>
                <div className="rounded-2xl border border-navy-700/70 bg-navy-950/42 p-4">
                  <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Momentum gate</p>
                  <p className="mt-1 text-sm font-medium text-white">{agentStudioSettings.autoRollbackMomentumThreshold}+ point recent drop</p>
                  <p className="mt-2 text-sm leading-relaxed text-slate-400">Lower values react faster. Higher values wait for a clearer recent collapse before rollback.</p>
                </div>
              </div>
              <div className="mt-4 grid gap-4">
                <div className="rounded-2xl border border-navy-700/70 bg-navy-950/42 p-4">
                  <p className="text-sm font-medium text-white">Workspace graduation defaults</p>
                  <p className="mt-2 text-sm leading-relaxed text-slate-400">
                    Pick how aggressively each workflow archetype should promote winning child branches. These are workspace defaults only. A workflow can still override them inside Agent Studio.
                  </p>
                  <div className="mt-4 space-y-3">
                    {WORKFLOW_ARCHETYPES.map((archetype) => (
                      <div key={archetype.id} className="rounded-2xl border border-white/6 bg-white/[0.03] p-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-medium text-white">{archetype.label}</p>
                            <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{archetype.help}</p>
                          </div>
                          <span className="ui-pill px-2 py-0.5 normal-case tracking-normal text-slate-300">
                            {AUTO_GRADUATION_PROFILES.find((profile) => profile.id === agentStudioSettings.autoGraduationProfiles[archetype.id])?.label || 'Inherited inside workflow'}
                          </span>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {AUTO_GRADUATION_PROFILES.map((profile) => (
                            <button
                              key={`${archetype.id}-${profile.id}`}
                              type="button"
                              onClick={() => setAgentStudioSettings((current) => ({
                                ...current,
                                autoGraduationProfiles: {
                                  ...current.autoGraduationProfiles,
                                  [archetype.id]: profile.id,
                                },
                              }))}
                              className={`ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal ${
                                agentStudioSettings.autoGraduationProfiles[archetype.id] === profile.id
                                  ? 'border-cyan-500/30 bg-cyan-500/12 text-cyan-200'
                                  : 'text-slate-300'
                              }`}
                            >
                              {profile.label}
                            </button>
                          ))}
                          <button
                            type="button"
                            onClick={() => setAgentStudioSettings((current) => {
                              const nextProfiles = { ...current.autoGraduationProfiles };
                              delete nextProfiles[archetype.id];
                              return {
                                ...current,
                                autoGraduationProfiles: nextProfiles,
                              };
                            })}
                            className="ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal text-slate-300"
                          >
                            Clear
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,0.92fr),minmax(0,1.08fr)]">
                <div className="rounded-2xl border border-navy-700/70 bg-navy-950/42 p-4">
                  <p className="text-sm font-medium text-white">Automatic rollback</p>
                  <p className="mt-2 text-sm leading-relaxed text-slate-400">
                    When enabled, an auto-graduated child can be unwound if follow-through weakens enough over the observed run window.
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setAgentStudioSettings((current) => ({ ...current, autoRollbackEnabled: !current.autoRollbackEnabled }))}
                      className={`ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal ${agentStudioSettings.autoRollbackEnabled ? 'border-red-500/30 bg-red-500/12 text-red-100' : 'text-slate-300'}`}
                    >
                      {agentStudioSettings.autoRollbackEnabled ? 'Enabled' : 'Disabled'}
                    </button>
                    {[8, 12, 16].map((threshold) => (
                      <button
                        key={`settings-auto-rollback-${threshold}`}
                        type="button"
                        onClick={() => setAgentStudioSettings((current) => ({ ...current, autoRollbackWeaknessThreshold: threshold }))}
                        className={`ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal ${agentStudioSettings.autoRollbackWeaknessThreshold === threshold ? 'border-cyan-500/30 bg-cyan-500/12 text-cyan-200' : 'text-slate-300'}`}
                      >
                        Trigger at {threshold}
                      </button>
                    ))}
                  </div>
                  <div className="mt-4 border-t border-white/6 pt-4">
                    <p className="text-sm font-medium text-white">Momentum sensitivity</p>
                    <p className="mt-2 text-sm leading-relaxed text-slate-400">
                      Guarded rollback should only fire when recent child momentum is meaningfully worse than the parent. This controls how strong that negative recent signal must be.
                    </p>
                    <div className="mt-4 flex flex-wrap gap-2">
                      {[4, 6, 9].map((threshold) => (
                        <button
                          key={`settings-auto-rollback-momentum-${threshold}`}
                          type="button"
                          onClick={() => setAgentStudioSettings((current) => ({ ...current, autoRollbackMomentumThreshold: threshold }))}
                          className={`ui-pill px-3 py-1.5 text-[11px] normal-case tracking-normal ${agentStudioSettings.autoRollbackMomentumThreshold === threshold ? 'border-cyan-500/30 bg-cyan-500/12 text-cyan-200' : 'text-slate-300'}`}
                        >
                          Require {threshold}+ point drop
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="rounded-2xl border border-navy-700/70 bg-navy-950/42 p-4">
                  <p className="text-sm font-medium text-white">How to think about it</p>
                  <div className="mt-3 space-y-3 text-sm text-slate-400">
                    <p><span className="text-white">8</span> is faster learning. Good when you want the system to self-correct aggressively.</p>
                    <p><span className="text-white">12</span> is balanced. Good default when you want fewer false reversals.</p>
                    <p><span className="text-white">16</span> is cautious. Better for high-stakes workflows where short-term noise should not undo the branch.</p>
                    <p><span className="text-white">Momentum sensitivity</span> keeps rollback from overreacting to noise. Lower values move faster. Higher values wait for a clearer recent collapse.</p>
                  </div>
                </div>
              </div>
            </section>

            <section className="rounded-[1.8rem] border border-navy-800/80 bg-gradient-to-b from-navy-900/72 via-navy-900/56 to-navy-950/88 p-5">
              <div className="flex items-center gap-2">
                <Shield className="h-4 w-4 text-amber-300" />
                <div>
                  <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Guidance</p>
                  <h2 className="text-sm font-semibold text-white">How to use this without making a mess</h2>
                </div>
              </div>
              <div className="mt-4 grid gap-3 md:grid-cols-3">
                <div className="rounded-2xl border border-navy-700/70 bg-navy-950/42 p-4">
                  <p className="text-sm font-medium text-white">Start with routing, not custom models</p>
                  <p className="mt-2 text-sm leading-relaxed text-slate-400">Most gains come from better workflow design and agent policy. Only override models when you have a concrete reason.</p>
                </div>
                <div className="rounded-2xl border border-navy-700/70 bg-navy-950/42 p-4">
                  <p className="text-sm font-medium text-white">Use BYOK for cost isolation</p>
                  <p className="mt-2 text-sm leading-relaxed text-slate-400">Workspace tokens are best when you want one client, team, or test environment to burn against its own provider accounts.</p>
                </div>
                <div className="rounded-2xl border border-navy-700/70 bg-navy-950/42 p-4">
                  <p className="text-sm font-medium text-white">Keep cheap work cheap</p>
                  <p className="mt-2 text-sm leading-relaxed text-slate-400">Use stronger models for hard reasoning and review, not for delivery steps, scheduling glue, or basic summaries.</p>
                </div>
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

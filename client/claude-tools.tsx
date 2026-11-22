import { useRpc } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text, View } from "react-native";
import { addGateway, importGatewayProvider, listGatewayProviders, listProfiles, linkProfile, moveCandidates, moveIdleAgent, setHeadroom, type AccountState, type GatewayProvider } from "../shared/contracts";
import type { AccountsProps } from "./accounts";
import { Button, Field, muted, Notice, row } from "./components";
import { useAction } from "./data";
import { errorMessage } from "./format";

export function ClaudeTools({ theme, state, host, onChanged }: AccountsProps & { state: AccountState }) {
  const save = useRpc(addGateway), discover = useRpc(listProfiles), link = useRpc(linkProfile);
  const discoverGateways = useRpc(listGatewayProviders), importGateway = useRpc(importGatewayProvider);
  const headroom = useRpc(setHeadroom), candidates = useRpc(moveCandidates), move = useRpc(moveIdleAgent);
  const [mode, setMode] = useState<"gateway" | "move" | null>(null);
  const [profiles, setProfiles] = useState<string[] | null>(null);
  // Paseo's own custom Claude providers that carry a gateway address and token.
  const [gateways, setGateways] = useState<GatewayProvider[]>([]);
  const find = async () => { const [names, providers] = await Promise.all([discover({}), discoverGateways({}).catch(() => [])]); setProfiles(names); setGateways(providers); };
  const [label, setLabel] = useState(""), [url, setUrl] = useState(""), [token, setToken] = useState("");
  const [from, setFrom] = useState("system-claude"), [to, setTo] = useState("");
  const [results, setResults] = useState<string[]>([]);
  const action = useAction(host.id, onChanged), busy = action.isPending;
  const subscriptions = state.accounts.filter(a => a.provider === "claude" && a.source !== "gateway");
  const options = subscriptions.map(a => ({ value: a.id, label: a.label }));
  const destinations = options.filter(option => option.value !== from && subscriptions.some(a => a.id === option.value && a.authStatus === "ready"));
  const destination = destinations.find(option => option.value === to)?.value ?? destinations[0]?.value;
  function closeForm() { setToken(""); setMode(null); }
  return <SettingsCard>
    <SettingsSwitch label="Prefer the most available subscription" value={Boolean(state.preferHeadroom)}
      hint="New Claude agents use the subscription with the most quota left in its tightest window. Always use the default takes priority."
      disabled={busy || !state.fallback.claude} onValueChange={enabled => action.run(() => headroom({ enabled }))} />
    <View style={{ padding: 12, gap: 10 }}>
      <View style={row}>
        <Button theme={theme} disabled={busy} onPress={() => action.run(find)}>Find local profiles</Button>
        <Button theme={theme} disabled={busy} onPress={() => mode === "gateway" ? closeForm() : setMode("gateway")}>Add gateway</Button>
        {options.length > 1 && state.providers.claude.integrated ? <Button theme={theme} disabled={busy} onPress={() => { setToken(""); setMode(mode === "move" ? null : "move"); }}>Move idle agents</Button> : null}
      </View>
      {profiles === null ? null : profiles.length ? profiles.map(name =>
        <Button key={name} theme={theme} disabled={busy} onPress={() => action.run(async () => { await link({ name }); await find(); })}>Link {name}</Button>)
        : gateways.length ? null : <Text style={muted(theme)}>No additional compatible Claude profiles found.</Text>}
      {profiles !== null && gateways.length ? <>
        <Text style={muted(theme)}>These Paseo providers use a gateway, not a Claude sign-in. Importing adds the gateway with its address and token; the provider entry stays as it is.</Text>
        {gateways.map(gateway => <Button key={gateway.provider} theme={theme} disabled={busy} label={`Import ${gateway.label} as gateway`}
          onPress={() => action.run(async () => { await importGateway({ provider: gateway.provider }); await find(); })}>{`Import ${gateway.label} as gateway · ${gateway.baseUrl}`}</Button>)}
      </> : null}
      {mode === "gateway" ? <>
        <Field theme={theme} accessibilityLabel="Gateway name" placeholder="Gateway name" maxLength={80} value={label} onChangeText={setLabel} />
        <Field theme={theme} accessibilityLabel="Gateway base URL" placeholder="https://gateway.example.com" autoCapitalize="none" autoCorrect={false} value={url} onChangeText={setUrl} />
        <Field theme={theme} accessibilityLabel="Gateway bearer token" placeholder="API token" autoCapitalize="none" autoCorrect={false} secureTextEntry value={token} onChangeText={setToken} />
        <Text style={muted(theme)}>Selecting this gateway sends that agent’s conversation to its endpoint. Subscription quotas apply only to subscription accounts.</Text>
        <View style={row}><Button theme={theme} variant="primary" disabled={busy || !label.trim() || !url.trim() || !token.trim()} onPress={() => action.run(async () => {
          await save({ label, base_url: url, api_token: token }); closeForm(); setLabel(""); setUrl("");
        })}>Save gateway</Button><Button theme={theme} disabled={busy} onPress={closeForm}>Cancel</Button></View>
      </> : null}
      {mode === "move" ? <>
        <SettingsSelect label="From subscription" value={from} options={options} disabled={busy} onValueChange={setFrom} />
        {destination ? <SettingsSelect label="To subscription" value={destination} options={destinations} disabled={busy} onValueChange={setTo} />
          : <Text style={muted(theme)}>Verify another subscription before moving agents.</Text>}
        <Button theme={theme} disabled={busy || !destination} onPress={() => action.run(async () => {
          if (!destination) return;
          setResults([]);
          const ids = await candidates({ accountId: from });
          if (!ids.length) setResults(["No agents on this subscription."]);
          for (const agentId of ids) {
            try { const result = await move({ agentId, from, to: destination }); setResults(prev => [...prev, agentId + " · " + result.detail]); }
            catch { setResults(prev => [...prev, agentId + " · Outcome unconfirmed. Check the agent before retrying."]); }
          }
        })}>{busy ? "Working…" : "Move idle agents now"}</Button>
        {results.map(line => <Text key={line} selectable style={muted(theme)}>{line}</Text>)}
      </> : null}
      {action.error ? <Notice theme={theme} tone="danger">{errorMessage(action.error)}</Notice> : null}
    </View>
  </SettingsCard>;
}

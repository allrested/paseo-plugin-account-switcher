import { useRpc } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Text, View } from "react-native";
import { BDDEV_HOST, setGatewayUsage, testGatewayUsage, type Account, type GatewayUsageTest, type UsageUnit } from "../shared/contracts";
import type { AccountsProps } from "./accounts";
import { body, Button, Field, muted, Notice, QuotaBalanceRow, row, Segmented } from "./components";
import { useAction } from "./data";
import { errorMessage, percent } from "./format";
import { bddevForm, FIELD_NAMES, formFromUsage, usageFromForm, type UsageForm } from "./gateway-usage-form";

const KINDS = [{ value: "off", label: "Off" }, { value: "endpoint", label: "Usage endpoint" }, { value: "file", label: "External reading" }] as const;
const UNITS: readonly { value: UsageUnit; label: string }[] = [{ value: "credits", label: "Credits" }, { value: "usd", label: "USD" }, { value: "requests", label: "Requests" }, { value: "tokens", label: "Tokens" }];
const FIELD_LABELS: Record<typeof FIELD_NAMES[number], string> = {
  used: "used", limit: "limit", remaining: "remaining", usedPercent: "percent used", resetsAt: "reset time", plan: "plan name", unlimited: "unlimited (true or false)",
};
const host = (baseUrl: string | undefined) => { try { return new URL(baseUrl ?? "").host; } catch { return ""; } };

/** How a gateway's usage is read: off, a usage endpoint on the gateway, or a file another tool writes. */
export function GatewayUsageForm({ theme, account, host: paseoHost, onChanged, onClose }: Pick<AccountsProps, "theme" | "host" | "onChanged"> & { account: Account; onClose(): void }) {
  const save = useRpc(setGatewayUsage), test = useRpc(testGatewayUsage);
  const [form, setForm] = useState<UsageForm>(() => formFromUsage(account.usage));
  const [result, setResult] = useState<GatewayUsageTest | null>(null);
  const action = useAction(paseoHost.id, onChanged), busy = action.isPending;
  const built = usageFromForm(form, account.baseUrl);
  const change = (patch: Partial<UsageForm>) => { setResult(null); setForm(current => ({ ...current, ...patch })); };
  const bddev = <Button theme={theme} disabled={busy} onPress={() => { setResult(null); setForm(bddevForm()); }}>Fill in for BDDev</Button>;
  const suggestBddev = host(account.baseUrl) === BDDEV_HOST;
  return <View style={{ gap: 10 }}>
    <Segmented theme={theme} label="Usage" value={form.kind} options={KINDS} disabled={busy} onChange={kind => change({ kind })} />
    {form.kind === "off" ? <Text style={muted(theme)}>No usage is read for this gateway.</Text> : null}
    {form.kind === "endpoint" ? <View style={{ gap: 8 }}>
      <Text style={muted(theme)}>A JSON usage endpoint on {host(account.baseUrl) || "the gateway"}. It is called with the gateway’s token, which is sent nowhere else.</Text>
      {suggestBddev ? <View style={row}>{bddev}</View> : null}
      <Field theme={theme} autoCorrect={false} autoCapitalize="none" placeholder="/api/usage" accessibilityLabel="Usage endpoint" value={form.path} onChangeText={path => change({ path })} />
      <Text style={muted(theme)}>Where each value is in the reply, such as data.total_used. Leave the ones the gateway does not report empty.</Text>
      {FIELD_NAMES.map(name => <Field key={name} theme={theme} autoCorrect={false} autoCapitalize="none" placeholder={`Field for ${FIELD_LABELS[name]}`}
        accessibilityLabel={`Field for ${name === "usedPercent" ? "percent" : name === "resetsAt" ? "reset" : name}`} value={form[name]} onChangeText={value => change({ [name]: value })} />)}
      <Segmented theme={theme} label="Unit" value={form.unit} options={UNITS} disabled={busy} onChange={unit => change({ unit })} />
      <View style={row}>
        <Field theme={theme} keyboardType="numeric" placeholder="Divide amounts by" accessibilityLabel="Divisor" value={form.divisor} onChangeText={divisor => change({ divisor })} />
        <Field theme={theme} maxLength={40} placeholder="Name shown" accessibilityLabel="Name shown" value={form.label} onChangeText={label => change({ label })} />
      </View>
      {suggestBddev ? null : <View style={row}>{bddev}</View>}
    </View> : null}
    {form.kind === "file" ? <View style={{ gap: 8 }}>
      <Text style={muted(theme)}>A file on this host that another tool keeps up to date, holding a fetchedAt time and a Paseo usage report. A reading older than 30 minutes shows as stale.</Text>
      <Field theme={theme} autoCorrect={false} autoCapitalize="none" placeholder="/path/to/usage.json" accessibilityLabel="Usage file" value={form.filePath} onChangeText={filePath => change({ filePath })} />
    </View> : null}
    {!built.ok ? <Notice theme={theme} tone="warning">{built.error}</Notice> : null}
    {result ? <View style={{ gap: 6 }}>
      {result.error ? <Notice theme={theme} tone="danger">{result.error}</Notice> : null}
      {result.ok && !result.windows.length && !result.balances.length ? <Notice theme={theme}>The reading is empty.</Notice> : null}
      {result.plan ? <Text style={muted(theme)}>{result.plan}</Text> : null}
      {result.windows.map(window => <Text key={window.id} style={body(theme)}>{window.label}: {percent(window.usedPercent)} used</Text>)}
      {result.balances.map(balance => <QuotaBalanceRow key={balance.id} theme={theme} balance={balance} />)}
    </View> : null}
    {action.error ? <Notice theme={theme} tone="danger">{errorMessage(action.error)}</Notice> : null}
    <View style={row}>
      {form.kind === "off" ? null : <Button theme={theme} disabled={busy || !built.ok} onPress={() => action.run(async () => {
        if (built.ok && built.usage) setResult(await test({ accountId: account.id, usage: built.usage }));
      })}>Test</Button>}
      <Button theme={theme} variant="primary" disabled={busy || !built.ok} onPress={() => action.run(async () => {
        if (!built.ok) return;
        await save({ accountId: account.id, usage: built.usage });
        onClose();
      })}>Save</Button>
      <Button theme={theme} variant="ghost" disabled={busy} onPress={onClose}>Cancel</Button>
    </View>
  </View>;
}

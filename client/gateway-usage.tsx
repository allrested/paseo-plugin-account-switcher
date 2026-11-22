import { useRpc } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { BDDEV_HOST, setGatewayUsage, testGatewayUsage, type Account, type GatewayUsageTest, type UsageUnit } from "../shared/contracts";
import type { AccountsProps } from "./accounts";
import { body, Button, Field, muted, Notice, QuotaBalanceRow, row, Segmented } from "./components";
import { useAction } from "./data";
import { errorMessage, percent } from "./format";
import { bddevForm, emptyReading, FIELD_NAMES, formFromUsage, MAX_PAGES, MAX_READINGS, usageFromForm, type ReadingForm, type UsageForm } from "./gateway-usage-form";

const KINDS = [{ value: "off", label: "Off" }, { value: "endpoint", label: "Usage endpoint" }, { value: "dashboard", label: "Usage dashboard" }, { value: "file", label: "External reading" }] as const;
const READING_KINDS = [{ value: "percent", label: "Percent" }, { value: "amount", label: "Amount" }] as const;
const UNITS: readonly { value: UsageUnit; label: string }[] = [{ value: "credits", label: "Credits" }, { value: "usd", label: "USD" }, { value: "requests", label: "Requests" }, { value: "tokens", label: "Tokens" }];
const FIELD_LABELS: Record<typeof FIELD_NAMES[number], string> = {
  used: "used", limit: "limit", remaining: "remaining", usedPercent: "percent used", resetsAt: "reset time", plan: "plan name", unlimited: "unlimited (true or false)",
};
const host = (baseUrl: string | undefined) => { try { return new URL(baseUrl ?? "").host; } catch { return ""; } };

/** How a gateway's usage is read: off, a usage endpoint on the gateway, a signed-in dashboard page, or a file another tool writes. */
export function GatewayUsageForm({ theme, account, host: paseoHost, onChanged, onClose }: Pick<AccountsProps, "theme" | "host" | "onChanged"> & { account: Account; onClose(): void }) {
  const save = useRpc(setGatewayUsage), test = useRpc(testGatewayUsage);
  const [form, setForm] = useState<UsageForm>(() => formFromUsage(account.usage, account.baseUrl));
  // The reading whose caption a chosen line of page text fills: the one last edited.
  const [focused, setFocused] = useState(0);
  const [result, setResult] = useState<GatewayUsageTest | null>(null);
  const action = useAction(paseoHost.id, onChanged), busy = action.isPending;
  const built = usageFromForm(form, account.baseUrl);
  const change = (patch: Partial<UsageForm>) => { setResult(null); setForm(current => ({ ...current, ...patch })); };
  const bddev = <Button theme={theme} disabled={busy} onPress={() => { setResult(null); setForm(current => bddevForm(current)); }}>Fill in for BDDev</Button>;
  const suggestBddev = host(account.baseUrl) === BDDEV_HOST;
  // Editing a reading keeps the last test's page text, so captions can be picked from it one after another.
  const edit = (patch: Partial<UsageForm>) => setForm(current => ({ ...current, ...patch }));
  const setReading = (index: number, patch: Partial<ReadingForm>) => edit({ readings: form.readings.map((reading, i) => i === index ? { ...reading, ...patch } : reading) });
  const setPage = (index: number, value: string) => change({ pages: form.pages.map((page, i) => i === index ? value : page) });
  const setBetween = (index: number, patch: Partial<{ after: string; before: string }>) => change({ between: form.pages.map((_, i) => ({ ...(form.between[i] ?? { after: "", before: "" }), ...(i === index ? patch : {}) })) });
  const pageOptions = form.pages.map((_, index) => ({ value: String(index), label: `Page ${index + 1}` }));
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
    {form.kind === "dashboard" ? <View style={{ gap: 8 }}>
      <Text style={muted(theme)}>Pages opened in the shared browser, which must already be signed in to the dashboard. Nothing is typed there, and the gateway’s token is not sent.</Text>
      <View style={row}>
        <Field theme={theme} autoCorrect={false} autoCapitalize="none" placeholder="Browser host" accessibilityLabel="Browser host" value={form.browserHost} onChangeText={browserHost => change({ browserHost })} />
        <Field theme={theme} keyboardType="numeric" placeholder="Port" accessibilityLabel="Browser port" value={form.browserPort} onChangeText={browserPort => change({ browserPort })} />
      </View>
      {form.pages.map((page, index) => <View key={index} style={{ gap: 6 }}>
        <Field theme={theme} autoCorrect={false} autoCapitalize="none" placeholder="https://gateway.example/dashboard" accessibilityLabel={`Page ${index + 1} address`} value={page} onChangeText={value => setPage(index, value)} />
        <View style={row}>
          <Field theme={theme} autoCorrect={false} placeholder="Only after the line (optional)" accessibilityLabel={`Page ${index + 1}: only after`} value={form.between[index]?.after ?? ""} onChangeText={after => setBetween(index, { after })} />
          <Field theme={theme} autoCorrect={false} placeholder="Only before the line (optional)" accessibilityLabel={`Page ${index + 1}: only before`} value={form.between[index]?.before ?? ""} onChangeText={before => setBetween(index, { before })} />
        </View>
      </View>)}
      <View style={row}>
        {form.pages.length < MAX_PAGES ? <Button theme={theme} disabled={busy} onPress={() => change({ pages: [...form.pages, ""], between: [...form.pages.map((_, i) => form.between[i] ?? { after: "", before: "" }), { after: "", before: "" }] })}>Add page</Button> : null}
        {form.pages.length > 1 ? <Button theme={theme} disabled={busy} onPress={() => change({ pages: form.pages.slice(0, -1), between: form.between.slice(0, form.pages.length - 1),
          readings: form.readings.map(reading => reading.page >= form.pages.length - 1 ? { ...reading, page: 0 } : reading) })}>Remove last page</Button> : null}
      </View>
      <Field theme={theme} autoCorrect={false} autoCapitalize="none" placeholder="Account to click on a sign-in page (optional)" accessibilityLabel="Account to click" value={form.accountTile} onChangeText={accountTile => change({ accountTile })} />
      <Text style={muted(theme)}>Each reading is a caption on the page, such as EST. COST, and the number shown after it. Press Test to see the page text and pick captions from it.</Text>
      {form.readings.map((reading, index) => <View key={index} style={{ gap: 6 }}>
        <View style={row}>
          <Field theme={theme} autoCorrect={false} placeholder="Caption on the page" accessibilityLabel={`Reading ${index + 1} caption`} value={reading.find} onFocus={() => setFocused(index)} onChangeText={find => setReading(index, { find })} />
          <Field theme={theme} maxLength={40} placeholder="Name shown" accessibilityLabel={`Reading ${index + 1} name`} value={reading.label} onFocus={() => setFocused(index)} onChangeText={label => setReading(index, { label })} />
        </View>
        <View style={row}>
          <Segmented theme={theme} label={`Reading ${index + 1} kind`} value={reading.type} options={READING_KINDS} disabled={busy} onChange={type => setReading(index, { type })} />
          {reading.type === "amount" ? <Segmented theme={theme} label={`Reading ${index + 1} unit`} value={reading.unit} options={UNITS} disabled={busy} onChange={unit => setReading(index, { unit })} /> : null}
          {form.pages.length > 1 ? <Segmented theme={theme} label={`Reading ${index + 1} page`} value={String(reading.page)} options={pageOptions} disabled={busy} onChange={page => setReading(index, { page: Number(page) })} /> : null}
          {form.readings.length > 1 ? <Button theme={theme} variant="ghost" disabled={busy} label={`Remove reading ${index + 1}`} onPress={() => { setFocused(0); edit({ readings: form.readings.filter((_, i) => i !== index) }); }}>Remove</Button> : null}
        </View>
      </View>)}
      {form.readings.length < MAX_READINGS ? <View style={row}><Button theme={theme} disabled={busy} onPress={() => { setFocused(form.readings.length); edit({ readings: [...form.readings, emptyReading()] }); }}>Add reading</Button></View> : null}
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
      {result.windows.map(window => <Text key={window.id} style={body(theme)}>{`${window.label}: ${percent(window.usedPercent)} used`}</Text>)}
      {result.balances.map(balance => <QuotaBalanceRow key={balance.id} theme={theme} balance={balance} />)}
      {form.kind === "dashboard" && result.lines?.length ? <View style={{ gap: 2 }}>
        <Text style={muted(theme)}>Page text. Press a line to use it as the caption of reading {Math.min(focused, form.readings.length - 1) + 1}.</Text>
        {result.lines.map((lines, page) => <View key={page} style={{ gap: 0 }}>
          {result.lines!.length > 1 ? <Text style={{ ...muted(theme), fontWeight: "600" }}>{`Page ${page + 1}`}</Text> : null}
          {lines.map((line, index) => <Pressable key={index} accessibilityRole="button" accessibilityLabel={`Use line: ${line}`}
            onPress={() => setReading(Math.min(focused, form.readings.length - 1), { find: line.slice(0, 120), page })}>
            <Text numberOfLines={1} style={muted(theme)}>{line}</Text>
          </Pressable>)}
        </View>)}
      </View> : null}
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

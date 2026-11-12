import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { TextField } from "@/components/ui/text-field";
import { useDeleteApp, useUpdateApp } from "@/hooks/use-apps";
import type { App, AppSettings } from "@/lib/api";

/**
 * A limit as typed: empty is none, a whole number above 0 is the limit, and anything else
 * (`1,000`, `10k`) is invalid rather than read as none.
 */
function limit(text: string): number | null | undefined {
  const value = text.trim();

  if (value === "") return null;

  if (!/^\d+$/.test(value)) return undefined;
  const number = Number(value);

  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

const LIMITS = [
  "monthlyRequests",
  "activeTunnels",
  "tenantMonthlyRequests",
  "tenantActiveTunnels",
] as const;

const shown = (value: number | null) => (value === null ? "" : String(value));

/**
 * An app's settings (ADR 0032): its name; where a browser without a pass goes to be signed in by
 * the app; which of the app's pages may open its pipes' WebSockets; and its limits, for the app
 * and as each customer's default. Deleting the app ends its pipes and revokes its keys.
 */
export function AppSettingsDialog({
  app,
  isOpen,
  onOpenChange,
  onDeleted,
}: {
  app: App;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const update = useUpdateApp(app.id);
  const remove = useDeleteApp();

  const initial = () => ({
    name: app.name,
    launchUrl: app.launchUrl ?? "",
    origins: app.allowedOrigins.join(" "),
    monthlyRequests: shown(app.monthlyRequests),
    activeTunnels: shown(app.activeTunnels),
    tenantMonthlyRequests: shown(app.tenantMonthlyRequests),
    tenantActiveTunnels: shown(app.tenantActiveTunnels),
  });

  const [form, setForm] = useState(initial);

  const set = (field: keyof ReturnType<typeof initial>) => (value: string) =>
    setForm((current) => ({ ...current, [field]: value }));

  const [confirming, setConfirming] = useState(false);
  // The dialog opens from its prop, not through `onOpenChange`: every opening starts from the
  // app as saved, so edits dismissed without saving never come back with the next save.
  useEffect(() => {
    if (isOpen) {
      setForm(initial());
      setConfirming(false);
    }
    // Only on opening: `initial` reads the app, and a refetch while editing must not reset.
  }, [isOpen]);

  const limits = {
    monthlyRequests: limit(form.monthlyRequests),
    activeTunnels: limit(form.activeTunnels),
    tenantMonthlyRequests: limit(form.tenantMonthlyRequests),
    tenantActiveTunnels: limit(form.tenantActiveTunnels),
  };

  const invalid = LIMITS.filter((key) => limits[key] === undefined);

  const save = () => {
    if (invalid.length > 0) return;

    const settings: AppSettings = {
      name: form.name,
      launchUrl: form.launchUrl.trim() || null,
      allowedOrigins: form.origins.split(/[\s,]+/).filter(Boolean),
      monthlyRequests: limits.monthlyRequests ?? null,
      activeTunnels: limits.activeTunnels ?? null,
      tenantMonthlyRequests: limits.tenantMonthlyRequests ?? null,
      tenantActiveTunnels: limits.tenantActiveTunnels ?? null,
    };

    update.mutate(settings, { onSuccess: () => onOpenChange(false) });
  };

  const field = (
    key: keyof ReturnType<typeof initial>,
    label: string,
    props: { placeholder?: string; type?: string; inputMode?: "numeric" } = {},
  ) => (
    <TextField
      value={form[key]}
      onChange={set(key)}
      type={props.type}
      isInvalid={invalid.some((invalidKey) => invalidKey === key)}
    >
      <Label>{label}</Label>
      <Input placeholder={props.placeholder} inputMode={props.inputMode} />
    </TextField>
  );

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) update.reset();
        onOpenChange(open);
      }}
      size="lg"
    >
      <DialogHeader>
        <DialogTitle>{app.name} settings</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <form
          id={`app-settings-${app.id}`}
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          {field("name", "Name")}
          {field("launchUrl", "Sign-in page", {
            placeholder: "https://app.example.com/wurmhol/launch",
            type: "url",
          })}
          {field("origins", "Pages that open pipes’ WebSockets", {
            placeholder: "https://app.example.com",
          })}
          <div className="grid gap-4 sm:grid-cols-2">
            {field("monthlyRequests", "Requests a month", {
              inputMode: "numeric",
              placeholder: "No limit",
            })}
            {field("activeTunnels", "Pipes open at once", {
              inputMode: "numeric",
              placeholder: "No limit",
            })}
            {field("tenantMonthlyRequests", "Requests a month, per customer", {
              inputMode: "numeric",
              placeholder: "No limit",
            })}
            {field("tenantActiveTunnels", "Pipes open, per customer", {
              inputMode: "numeric",
              placeholder: "10",
            })}
          </div>
          {invalid.length > 0 && (
            <Text className="text-xs text-danger">
              Limits are whole numbers, like 10000, or empty for none.
            </Text>
          )}
          {update.error && <Text className="text-xs text-danger">{update.error.message}</Text>}
        </form>
      </DialogBody>
      <DialogFooter>
        {confirming ? (
          <Button
            intent="danger"
            className="me-auto"
            isPending={remove.isPending}
            onPress={() =>
              remove.mutate(app.id, {
                onSuccess: () => {
                  onOpenChange(false);
                  onDeleted();
                },
              })
            }
          >
            Delete app, end its pipes and revoke its keys
          </Button>
        ) : (
          <Button intent="danger" className="me-auto" onPress={() => setConfirming(true)}>
            Delete app
          </Button>
        )}
        <Button type="submit" form={`app-settings-${app.id}`} isPending={update.isPending}>
          Save
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

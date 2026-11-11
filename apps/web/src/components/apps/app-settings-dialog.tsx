import { useState } from "react";
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

/** A limit as typed: empty is none. */
const limit = (text: string) => (text.trim() === "" ? null : Number(text));
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

  const save = () => {
    const settings: AppSettings = {
      name: form.name,
      launchUrl: form.launchUrl.trim() || null,
      allowedOrigins: form.origins.split(/[\s,]+/).filter(Boolean),
      monthlyRequests: limit(form.monthlyRequests),
      activeTunnels: limit(form.activeTunnels),
      tenantMonthlyRequests: limit(form.tenantMonthlyRequests),
      tenantActiveTunnels: limit(form.tenantActiveTunnels),
    };
    update.mutate(settings, { onSuccess: () => onOpenChange(false) });
  };

  const field = (
    key: keyof ReturnType<typeof initial>,
    label: string,
    props: { placeholder?: string; type?: string; inputMode?: "numeric" } = {},
  ) => (
    <TextField value={form[key]} onChange={set(key)} type={props.type}>
      <Label>{label}</Label>
      <Input placeholder={props.placeholder} inputMode={props.inputMode} />
    </TextField>
  );

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (open) setForm(initial());
        else {
          update.reset();
          setConfirming(false);
        }
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

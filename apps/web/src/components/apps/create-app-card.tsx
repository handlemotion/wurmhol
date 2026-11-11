import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TextField } from "@/components/ui/text-field";
import { useCreateApp } from "@/hooks/use-apps";

/**
 * New app: a name, then the app's own card opens, where its keys and settings are. An app is
 * your product that opens private pipes for its own users (ADR 0032).
 */
export function CreateAppCard({ onCreated }: { onCreated: (id: string) => void }) {
  const card = useRef<HTMLElement>(null);
  useEffect(() => card.current?.focus({ preventScroll: true }), []);
  const create = useCreateApp();
  const [name, setName] = useState("");
  return (
    <section
      ref={card}
      tabIndex={-1}
      data-open
      aria-label="New app"
      className="flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-4 border border-border bg-background p-4 outline-0"
    >
      <span className="text-sm text-foreground">New app</span>
      <p className="text-xs text-muted-foreground">
        Your product, opening private pipes for its own users. They sign in through it, not here.
      </p>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate({ name }, { onSuccess: ({ app }) => onCreated(app.id) });
        }}
      >
        <TextField
          aria-label="App name"
          isRequired
          value={name}
          onChange={setName}
          className="flex-1"
        >
          <Input placeholder="Name, like “Dorks”" />
        </TextField>
        <Button type="submit" isPending={create.isPending}>
          Create
        </Button>
      </form>
      {create.error && <p className="text-xs text-danger">{create.error.message}</p>}
    </section>
  );
}

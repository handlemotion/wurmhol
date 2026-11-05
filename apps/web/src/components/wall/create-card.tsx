import { NPM } from "@ridemountainpig/svgl-react";
import { cn } from "cn";
import { useState } from "react";
import { Skeleton } from "skullet/react";
import {
  IconArrowLeft,
  IconArrowUpRight,
  IconCheck,
  IconLaptop,
  IconSparkles,
} from "@/components/icons/lucide";
import { ActionItem, ActionList } from "@/components/ui/action-list";
import { Button } from "@/components/ui/button";
import { CopyField } from "@/components/ui/copy-field";
import { Link } from "@/components/ui/link";
import { Loader } from "@/components/ui/loader";
import { useAppConfig, useMachines, useOpenPort, useSetupCode } from "@/hooks/use-app";
import { useClipboard } from "@/hooks/use-clipboard";
import type { Machine } from "@/lib/api";

const COMMAND = "npx wurmhol <port>";
const PROMPT =
  "Start the dev server, then run `npx wurmhol <port>` with its port and send me the URL it prints.";

/** The command Create from this computer copies, with its setup code (ADR 0020). */
const host = (code: string) => `npx wurmhol host --code ${code}`;

/** npm's mark (svgl) at 13px inside the rows' 15px icon slot, as the design draws it. */
function NpmMark() {
  return (
    <span aria-hidden className="flex size-icon shrink-0 items-center justify-center">
      <NPM className="size-3.25" />
    </span>
  );
}

/**
 * The ways to start a pipe. Every copy row's label is the verb and what it copies; once copied,
 * the row names what is on the clipboard. The last row opens this computer's steps in place.
 */
const CREATE = [
  {
    id: "prompt",
    label: "Copy agent prompt",
    done: "Prompt copied",
    value: PROMPT,
    Icon: IconSparkles,
  },
  {
    id: "command",
    label: "Copy npx command",
    done: "Command copied",
    value: COMMAND,
    Icon: NpmMark,
  },
  {
    id: "machine",
    label: "Create from this computer",
    done: null,
    value: null,
    Icon: IconLaptop,
  },
] as const;

/**
 * Create pipe, open: a muted label over the ways to start one. A fixed square, so options can be
 * added, and this computer's steps shown in its place, without the card changing shape. A row
 * says "Copied" for a moment after its press.
 */
export function CreateCard({ onOpened }: { onOpened: (url: string) => void }) {
  const { copy, copied } = useClipboard();
  const [last, setLast] = useState<string | null>(null);
  const [view, setView] = useState<"ways" | "machine">("ways");
  const docs = useAppConfig().data?.docsUrl;
  return (
    <section
      data-open
      aria-label="Create pipe"
      className="flex size-72 flex-col gap-0.5 border border-border bg-background p-2"
    >
      {view === "machine" ? (
        <MachineSteps onBack={() => setView("ways")} onOpened={onOpened} />
      ) : (
        <>
          <span aria-hidden className="flex h-8 items-center px-2 text-xs text-subtle-foreground">
            Create pipe
          </span>
          {/* Focus lands on the first row, so arrows, Enter and Escape work from the start. */}
          <ActionList
            aria-label="Create pipe"
            autoFocus="first"
            onAction={(key) => {
              const option = CREATE.find((item) => item.id === key);
              if (!option) return;
              if (option.value === null) return setView("machine");
              setLast(option.id);
              void copy(option.value);
            }}
          >
            {CREATE.map(({ id, label, done, Icon }) => (
              <ActionItem key={id} id={id} textValue={label}>
                {copied && last === id ? <IconCheck /> : <Icon aria-hidden />}
                <span className="truncate">{copied && last === id ? done : label}</span>
              </ActionItem>
            ))}
          </ActionList>
          {/* The footer mirrors the label above: same row, same muted type, pinned to the bottom. */}
          {docs && (
            <Link
              href={docs}
              target="_blank"
              rel="noopener"
              className="mt-auto flex h-8 items-center gap-1 px-2 text-xs text-subtle-foreground hover:text-foreground"
            >
              Docs
              <IconArrowUpRight className="size-3" />
            </Link>
          )}
        </>
      )}
    </section>
  );
}

/** A step's mark: its number while ahead or open, a check once done. In the rows' icon slot. */
function StepMark({ n, done }: { n: number; done: boolean }) {
  return (
    <span
      aria-hidden
      className="flex size-icon shrink-0 items-center justify-center text-xs text-muted-foreground tabular-nums"
    >
      {done ? <IconCheck className="size-icon" /> : n}
    </span>
  );
}

/**
 * Create from this computer (ADR 0018, 0020): run the command here, then pick a port it found.
 * The command carries a setup code for the signed-in person, so the CLI needs no approval. The
 * first step collapses to its answer once a computer connects; picking a port opens its pipe and
 * its card.
 */
function MachineSteps({
  onBack,
  onOpened,
}: {
  onBack: () => void;
  onOpened: (url: string) => void;
}) {
  const machines = useMachines(true);
  const openPort = useOpenPort();
  const connected = machines?.length ? machines : null;
  const setup = useSetupCode(!connected);
  const row = "flex h-8 items-center gap-2.5 px-2 text-sm";
  return (
    <>
      <div className="flex h-8 items-center gap-1">
        <Button intent="plain" size="sq-xs" aria-label="Back" autoFocus onPress={onBack}>
          <IconArrowLeft />
        </Button>
        <span className="text-xs text-subtle-foreground">Create from this computer</span>
      </div>
      <ol className="flex min-h-0 flex-1 flex-col gap-0.5">
        <li className="flex flex-col gap-1">
          <span className={cn(row, connected ? "text-muted-foreground" : "text-foreground")}>
            <StepMark n={1} done={Boolean(connected)} />
            <span className="truncate">
              {connected
                ? `Running on ${connected.map((m) => m.name).join(", ")}`
                : "Run the CLI here"}
            </span>
          </span>
          {!connected && (
            <div className="ps-8.25 pe-2">
              {setup.isError ? (
                <span role="alert" className="text-xs text-danger-subtle-foreground">
                  {setup.error.message}
                </span>
              ) : (
                <Skeleton
                  id="setup-code"
                  data={setup.data}
                  sample={{ code: "x".repeat(40), expires_in: 1800 }}
                  label="Loading the command"
                >
                  {({ code }) => <CopyField label="Run" value={host(code)} />}
                </Skeleton>
              )}
            </div>
          )}
        </li>
        <li className="flex min-h-0 flex-1 flex-col">
          <span className={cn(row, connected ? "text-foreground" : "text-subtle-foreground")}>
            <StepMark n={2} done={false} />
            <span className="truncate">Pick a port</span>
          </span>
          {connected && (
            <Ports
              machines={connected}
              pending={openPort.isPending ? openPort.variables : null}
              onPick={(machine, port) =>
                openPort.mutate({ machine, port }, { onSuccess: ({ url }) => onOpened(url) })
              }
            />
          )}
        </li>
      </ol>
      {openPort.error && (
        <span
          role="alert"
          className="flex h-8 items-center px-2 text-xs text-danger-subtle-foreground"
        >
          <span className="truncate">{openPort.error.message}</span>
        </span>
      )}
    </>
  );
}

/** The web servers a connected computer found, one row each; with two computers, under each name. */
function Ports(props: {
  machines: Machine[];
  /** The port being opened, while it is. */
  pending: { machine: string; port: number } | null;
  onPick: (machine: string, port: number) => void;
}) {
  const several = props.machines.length > 1;
  const items = props.machines.flatMap((machine) =>
    machine.ports.map((p) => ({ key: `${machine.id}:${p.port}`, machine, ...p })),
  );
  if (!items.length) {
    return (
      <span className="flex min-h-8 items-center gap-2.5 px-2 text-xs text-muted-foreground">
        <span aria-hidden className="size-icon shrink-0" />
        No web server is running there yet. Start one and it shows up here.
      </span>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <ActionList
        aria-label="Ports"
        onAction={(key) => {
          const item = items.find((i) => i.key === key);
          if (item && !props.pending) props.onPick(item.machine.id, item.port);
        }}
      >
        {items.map(({ key, machine, port, title }) => (
          <ActionItem key={key} id={key} textValue={`${port} ${title ?? ""}`}>
            {/* The steps' mark slot, so ports line up under "Pick a port". */}
            {props.pending?.machine === machine.id && props.pending.port === port ? (
              <Loader className="size-icon" />
            ) : (
              <span aria-hidden className="size-icon shrink-0" />
            )}
            <span className="shrink-0 tabular-nums">:{port}</span>
            <span className="truncate text-muted-foreground">
              {[title, several ? machine.name : null].filter(Boolean).join(" · ")}
            </span>
          </ActionItem>
        ))}
      </ActionList>
    </div>
  );
}

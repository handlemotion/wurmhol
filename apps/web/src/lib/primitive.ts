"use client";

import { composeRenderProps } from "react-aria-components/composeRenderProps";
import { cn, type ClassNameValue } from "cn";
import type { ReactNode } from "react";
import { z } from "zod/mini";

const textChild = z.string();

/** A child that is plain text, which components set in their own label; undefined otherwise. */
export function plainText<T>(child: ReactNode | ((values: T) => ReactNode)): string | undefined {
  const text = textChild.safeParse(child);

  return text.success ? text.data : undefined;
}

/** A React Aria component's children for its current render props: called when a function. */
export function renderChildren<T>(children: ReactNode | ((values: T) => ReactNode), values: T) {
  return composeRenderProps(children, (child: ReactNode) => child)(values);
}

type Render<T> = string | ((v: T) => string) | undefined;

export function cx<T = unknown>(
  ...classes: [...ClassNameValue[], Render<T>]
): string | ((v: T) => string) {
  // SAFETY: the parameter tuple always ends with the `Render<T>` this takes off.
  const className = classes.pop() as Render<T>;

  return composeRenderProps(className, (className) => cn(classes, className));
}

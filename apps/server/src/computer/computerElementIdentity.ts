import type { ComputerTarget, ComputerUiNode } from "@synara/contracts";

// Native handles stay inside the server. Neither the provider-facing ref nor
// the public ComputerTarget schema exposes an actuator token.
const nativeIdentities = new WeakMap<
  ComputerUiNode,
  {
    readonly identity: string;
    readonly actions: readonly string[];
    readonly selected?: boolean | undefined;
  }
>();
const observedElement = Symbol("computerObservedElement");

type ObservedComputerElement = {
  readonly [observedElement]?: ComputerUiNode;
};

export function registerNativeComputerElement(
  node: ComputerUiNode,
  identity: string,
  actions: readonly string[] = [],
  selected?: boolean,
): void {
  nativeIdentities.set(node, { identity, actions: [...actions], selected });
}

/** Only the backend can establish native addressability; public node JSON cannot. */
export function nativeComputerElementActions(node: ComputerUiNode): readonly string[] | undefined {
  return nativeIdentities.get(node)?.actions;
}

export function nativeComputerElementSelected(node: ComputerUiNode): boolean | undefined {
  return nativeIdentities.get(node)?.selected;
}

export function retainComputerElementRef<T extends object>(ref: T, node: ComputerUiNode): T {
  // Digests are copied when stable refs and wire fields are added. A private
  // enumerable symbol keeps their native identity through those spreads;
  // JSON cannot expose or manufacture it.
  return nativeIdentities.has(node) ? { ...ref, [observedElement]: node } : ref;
}

export function computerElementRefIdentity(ref: object): string | undefined {
  const node = (ref as ObservedComputerElement)[observedElement];
  return node ? nativeIdentities.get(node)?.identity : undefined;
}

export function bindComputerTargetRef(target: ComputerTarget, ref: object): ComputerTarget {
  const node = (ref as ObservedComputerElement)[observedElement];
  // Enumerable symbols survive internal object spreads, but JSON/provider
  // serialization cannot carry or manufacture this server-owned binding.
  if (!node) return target;
  const bound: ComputerTarget & ObservedComputerElement = { ...target, [observedElement]: node };
  return bound;
}

export function observedComputerTargetNode(target: ComputerTarget): ComputerUiNode | undefined {
  return (target as ObservedComputerElement)[observedElement];
}

import type { TaskNode } from "./model";

export type AccessContext = {
  userId: string;
  memberId: string;
  role: "manager" | "executor" | "viewer";
  displayName: string;
};

export function canManage(viewer: AccessContext): boolean {
  return viewer.role === "manager";
}

export function canSubmit(viewer: AccessContext, node: TaskNode): boolean {
  return canManage(viewer) || (viewer.role === "executor" &&
    (node.ownerId === viewer.memberId || node.participants.includes(viewer.memberId)));
}

/** A personal channel is readable by its assigned recipient and the manager. */
export function canReadChannel(viewer: AccessContext, channel: string | null): boolean {
  return channel === null || canManage(viewer) ||
    (["executor","viewer"].includes(viewer.role) && viewer.memberId === channel);
}

export function canWriteChannel(viewer: AccessContext, channel: string | null): boolean {
  return viewer.role !== "viewer" && canReadChannel(viewer, channel);
}

import { z } from "zod";

export const ServiceSchema = z.object({
  id: z.string().min(1),
  command: z.string().min(1),
  cwd: z.string().optional(),
  port: z.number().int().positive().optional(),
  dependsOn: z.array(z.string()).default([]),
  healthcheck: z.string().optional(),
});

export const TaskSchema = z.object({
  id: z.string().min(1),
  command: z.string().min(1),
});

export const EnvironmentManifestSchema = z.object({
  version: z.literal(1),
  services: z.array(ServiceSchema).default([]),
  tasks: z.array(TaskSchema).default([]),
  seed: z.array(TaskSchema).default([]),
  cleanup: z.array(TaskSchema).default([]),
  qa: z
    .object({
      baseUrl: z.string().url().optional(),
    })
    .optional(),
});

export type EnvironmentManifest = z.infer<typeof EnvironmentManifestSchema>;

export type ManifestValidationIssue = {
  code: "duplicate_port" | "duplicate_id" | "cycle" | "missing_dependency";
  message: string;
};

export function validateManifest(manifest: EnvironmentManifest): ManifestValidationIssue[] {
  const issues: ManifestValidationIssue[] = [];
  const ids = new Set<string>();
  const ports = new Map<number, string>();

  for (const service of manifest.services) {
    if (ids.has(service.id)) {
      issues.push({
        code: "duplicate_id",
        message: `Duplicate service id: ${service.id}`,
      });
    }
    ids.add(service.id);
    if (service.port !== undefined) {
      const existing = ports.get(service.port);
      if (existing) {
        issues.push({
          code: "duplicate_port",
          message: `Port ${service.port} used by ${existing} and ${service.id}`,
        });
      }
      ports.set(service.port, service.id);
    }
  }

  const graph = new Map<string, string[]>();
  for (const service of manifest.services) {
    graph.set(service.id, service.dependsOn);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function dfs(node: string): boolean {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const dep of graph.get(node) ?? []) {
      if (!graph.has(dep)) {
        issues.push({
          code: "missing_dependency",
          message: `Service ${node} depends on missing ${dep}`,
        });
      } else if (dfs(dep)) {
        issues.push({ code: "cycle", message: `Dependency cycle involving ${node}` });
        return true;
      }
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  }

  for (const id of graph.keys()) dfs(id);
  return issues;
}

export type SupervisorState = "stopped" | "starting" | "running" | "stopping";

export class ServiceSupervisor {
  private readonly states = new Map<string, SupervisorState>();

  getState(serviceId: string): SupervisorState {
    return this.states.get(serviceId) ?? "stopped";
  }

  async startOrdered(manifest: EnvironmentManifest): Promise<void> {
    const order = topologicalSort(manifest.services.map((s) => ({
      id: s.id,
      dependsOn: s.dependsOn,
    })));
    for (const id of order) {
      this.states.set(id, "starting");
      this.states.set(id, "running");
    }
  }

  async stopOrdered(manifest: EnvironmentManifest): Promise<void> {
    const order = topologicalSort(manifest.services.map((s) => ({
      id: s.id,
      dependsOn: s.dependsOn,
    }))).reverse();
    for (const id of order) {
      this.states.set(id, "stopping");
      this.states.set(id, "stopped");
    }
  }
}

function topologicalSort(
  services: Array<{ id: string; dependsOn: string[] }>,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const byId = new Map(services.map((s) => [s.id, s]));

  function visit(id: string): void {
    if (seen.has(id)) return;
    seen.add(id);
    const svc = byId.get(id);
    for (const dep of svc?.dependsOn ?? []) visit(dep);
    result.push(id);
  }

  for (const s of services) visit(s.id);
  return result;
}

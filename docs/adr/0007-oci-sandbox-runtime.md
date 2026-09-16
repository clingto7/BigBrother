# ADR 0007: Use an OCI Sandbox with Podman as the Reference Runtime

Status: Superseded for the initial static profile by ADR 0008

Big Brother will target OCI container semantics rather than a Docker-specific
or Podman-specific API. Podman is the reference runtime for local and
production deployments because rootless operation keeps the engine and
container in a non-root user namespace. Docker remains a supported Adapter
for environments that standardize on Docker Desktop or a rootless Docker
Engine.

When an OCI profile is selected, the control plane and Prime runtime run inside
one rootless OCI container. Project code is not executed and project
dependencies are not installed in the initial profile. Only an explicitly
scoped service-state volume and the workspace volume are mounted. GitHub and
model credentials are injected by runtime secret mechanisms and are never
placed in the image, repository workspace, or durable review state.

If a later review profile permits executing repository code, the worker must
move to a separately managed per-review container with a read-only workspace,
no GitHub credentials, resource limits, and a narrowly scoped model/result
communication path. The control plane must not mount a host Docker/Podman
socket into an untrusted worker.

The container engine is selected at deployment time, for example with
`CONTAINER_ENGINE=podman` or `CONTAINER_ENGINE=docker`; domain modules do not
call either CLI directly. On macOS both engines use a Linux VM or machine, so
engine availability is an operational prerequisite rather than a code-level
assumption.

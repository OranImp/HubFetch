"""Task list/detail inspection UI package.

Todo 26 composes the transfer ledger's task inspection surface: an
incrementally updated queue model, a detail view with accessible stage rail
and byte/speed progress, a virtualized sanitized event timeline, and a pure
action model routing Cancel/Retry/Open Folder/Copy Diagnostic through an
injected command seam (never directly into the runtime).
"""

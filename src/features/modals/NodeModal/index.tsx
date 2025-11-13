import React, { useEffect, useMemo, useState } from "react";
import type { ModalProps } from "@mantine/core";
import {
  Modal,
  Stack,
  Text,
  ScrollArea,
  Flex,
  CloseButton,
  Button,
  Group,
  Textarea,
} from "@mantine/core";
import { CodeHighlight } from "@mantine/code-highlight";
import useFile from "../../../store/useFile";
import type { NodeData } from "../../../types/graph";
import useGraph from "../../editor/views/GraphView/stores/useGraph";

// return object from json removing array and object fields
const normalizeNodeData = (nodeRows: NodeData["text"]) => {
  if (!nodeRows || nodeRows.length === 0) return "{}";
  if (nodeRows.length === 1 && !nodeRows[0].key) return `${nodeRows[0].value}`;

  const obj = {};
  nodeRows?.forEach(row => {
    if (row.type !== "array" && row.type !== "object") {
      if (row.key) obj[row.key] = row.value;
    }
  });
  return JSON.stringify(obj, null, 2);
};

// return json path in the format $["customer"]
const jsonPathToString = (path?: NodeData["path"]) => {
  if (!path || path.length === 0) return "$";
  const segments = path.map(seg => (typeof seg === "number" ? seg : `"${seg}"`));
  return `$[${segments.join("][")}]`;
};

// Helpers to navigate and immutably update JSON values using a JSONPath (array of keys/indices)
type _Path = Exclude<NodeData["path"], undefined>;

const getValueByPath = (root: unknown, path?: NodeData["path"]): unknown => {
  if (!path || path.length === 0) return root;

  let cur: unknown = root;
  for (const seg of path) {
    if (cur === undefined || cur === null) return undefined;
    if (typeof seg === "number") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[seg];
    } else {
      if (typeof cur !== "object" || Array.isArray(cur)) return undefined;
      cur = (cur as Record<string, unknown>)[seg as string];
    }
  }
  return cur;
};

const setValueByPath = (
  root: unknown,
  path: NodeData["path"] | undefined,
  value: unknown
): unknown => {
  // immutable set: returns a new root with value set at path
  if (!path || path.length === 0) return value;

  const setAt = (node: unknown, pathSegs: _Path): unknown => {
    const [head, ...rest] = pathSegs;
    const isLast = rest.length === 0;

    if (typeof head === "number") {
      const arr = Array.isArray(node) ? [...(node as any[])] : [];
      const idx = head;
      const current = arr[idx];
      arr[idx] = isLast ? value : setAt(current, rest as _Path);
      return arr;
    }

    const key = String(head);
    const obj =
      node && typeof node === "object" && !Array.isArray(node)
        ? { ...(node as Record<string, unknown>) }
        : {};
    (obj as Record<string, unknown>)[key] = isLast
      ? value
      : setAt((obj as Record<string, unknown>)[key], rest as _Path);
    return obj;
  };

  return setAt(root, path as _Path);
};

const mergePrimitivesAtPath = (
  root: unknown,
  path: NodeData["path"] | undefined,
  partial: Record<string, unknown>
): unknown => {
  const target = getValueByPath(root, path);
  const base =
    target && typeof target === "object" && !Array.isArray(target)
      ? { ...(target as Record<string, unknown>) }
      : {};

  for (const [k, v] of Object.entries(partial)) {
    // skip objects and arrays (only merge primitives/null)
    if (v !== null && typeof v === "object") continue;
    // assign primitive
    (base as Record<string, unknown>)[k] = v;
  }

  return setValueByPath(root, path, base);
};

// compare two JSONPath-like arrays for equality
const pathsEqual = (a?: NodeData["path"], b?: NodeData["path"]): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
};

export const NodeModal = ({ opened, onClose }: ModalProps) => {
  const nodeData = useGraph(state => state.selectedNode);
  const setSelectedNode = useGraph(state => state.setSelectedNode);
  const nodes = useGraph(state => state.nodes);

  const normalized = useMemo(() => normalizeNodeData(nodeData?.text ?? []), [nodeData]);

  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(() => normalized);

  // determine whether the selected node is editable:
  // - must have a valid path
  // - should not represent an array/object container node
  const isEditable = useMemo(() => {
    if (!nodeData?.path || nodeData.path.length === 0) return false;
    if (!nodeData?.text || nodeData.text.length === 0) return false;
    // if the node rows are only container types (object/array) treat as non-editable
    const onlyContainers = nodeData.text.every(r => r.type === "array" || r.type === "object");
    if (onlyContainers) return false;
    return true;
  }, [nodeData]);

  const isDraftNonEmpty = draft.trim().length > 0;
  const isDraftParseable = useMemo(() => {
    if (!isDraftNonEmpty) return false;
    try {
      JSON.parse(draft);
      return true;
    } catch {
      return false;
    }
  }, [draft, isDraftNonEmpty]);

  useEffect(() => {
    // reset draft when the selected node changes
    setDraft(normalized);
    // when node switches, exit editing mode
    setIsEditing(false);
  }, [normalized]);

  // Keep the selected node in sync with graph updates (e.g., after save/parse)
  useEffect(() => {
    if (!nodeData?.path || !Array.isArray(nodes) || nodes.length === 0) return;

    const matched = nodes.find(n => pathsEqual(n.path, nodeData.path));
    if (!matched) return;

    // Update selection if reference or content changed
    const currentText = JSON.stringify(nodeData.text ?? []);
    const nextText = JSON.stringify(matched.text ?? []);
    if (nodeData !== matched || currentText !== nextText) {
      setSelectedNode(matched);
    }
  }, [nodes, nodeData?.path, nodeData?.text, setSelectedNode]);

  return (
    <Modal size="auto" opened={opened} onClose={onClose} centered withCloseButton={false}>
      <Stack pb="sm" gap="sm">
        <Stack gap="xs">
          <Flex justify="space-between" align="center">
            <Text fz="xs" fw={500}>
              Content
            </Text>
            <Group gap="xs">
              {!isEditing ? (
                <Button
                  size="xs"
                  variant="default"
                  onClick={() => isEditable && setIsEditing(true)}
                  disabled={!isEditable}
                >
                  Edit
                </Button>
              ) : (
                <>
                  <Button
                    size="xs"
                    disabled={!isDraftNonEmpty || !isDraftParseable}
                    onClick={() => {
                      if (!nodeData) return;
                      // read canonical JSON from app state (via file contents so editor/file state is authoritative)
                      const jsonStr = useFile.getState().getContents();
                      let root: unknown;
                      try {
                        root = JSON.parse(jsonStr);
                      } catch (err) {
                        // malformed app JSON (shouldn't happen normally)
                        // eslint-disable-next-line no-alert
                        alert("App JSON is invalid: " + (err as Error).message);
                        return;
                      }

                      try {
                        const parsed = JSON.parse(draft);

                        let newRoot: unknown = root;

                        // detect primitive node by convention: single row with no key
                        const isPrimitiveNode =
                          nodeData.text && nodeData.text.length === 1 && !nodeData.text[0].key;

                        if (isPrimitiveNode) {
                          // parsed must be a primitive
                          if (parsed !== null && typeof parsed === "object") {
                            // invalid for primitive node
                            alert(
                              "Expected a primitive value for this node (string, number, boolean, or null)"
                            );
                            return;
                          }
                          newRoot = setValueByPath(root, nodeData.path, parsed);
                        } else {
                          // object-like node: parsed must be an object
                          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                            alert("Expected an object for this node");
                            return;
                          }
                          // merge only primitive fields
                          newRoot = mergePrimitivesAtPath(
                            root,
                            nodeData.path,
                            parsed as Record<string, unknown>
                          );
                        }

                        // write back using existing pipeline so graph/editor refresh
                        useFile.getState().setContents({
                          contents: JSON.stringify(newRoot, null, 2),
                          hasChanges: true,
                        });
                        // keep modal open but exit edit mode; graph/editor will refresh via pipeline
                        setIsEditing(false);

                        // Immediately try to reselect the node by its path using the latest nodes
                        try {
                          const latestNodes = useGraph.getState().nodes;
                          const matched = latestNodes.find(n => pathsEqual(n.path, nodeData.path));
                          if (matched) {
                            setSelectedNode(matched);
                          }
                        } catch (e) {
                          // ignore selection failures — graph will update via pipeline
                        }
                      } catch (err) {
                        // parsing error for draft
                        // eslint-disable-next-line no-alert
                        alert("Invalid JSON in editor: " + (err as Error).message);
                      }
                    }}
                  >
                    Save
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => {
                      // cancel editing: reset draft and exit edit mode
                      setDraft(normalized);
                      setIsEditing(false);
                    }}
                  >
                    Cancel
                  </Button>
                </>
              )}
              <CloseButton onClick={onClose} />
            </Group>
          </Flex>
          <ScrollArea.Autosize mah={250} maw={600}>
            {isEditing ? (
              <Textarea
                value={draft}
                onChange={e => setDraft(e.currentTarget.value)}
                minRows={3}
                maxRows={12}
                autosize
                // ensure the textarea uses a monospace font
                styles={{
                  input: {
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
                    fontSize: 13,
                  },
                }}
                style={{ minWidth: 350, maxWidth: 600 }}
              />
            ) : (
              <CodeHighlight code={normalized} miw={350} maw={600} language="json" withCopyButton />
            )}
          </ScrollArea.Autosize>
        </Stack>
        <Text fz="xs" fw={500}>
          JSON Path
        </Text>
        <ScrollArea.Autosize maw={600}>
          <CodeHighlight
            code={jsonPathToString(nodeData?.path)}
            miw={350}
            mah={250}
            language="json"
            copyLabel="Copy to clipboard"
            copiedLabel="Copied to clipboard"
            withCopyButton
          />
        </ScrollArea.Autosize>
      </Stack>
    </Modal>
  );
};

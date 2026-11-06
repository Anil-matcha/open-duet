"use client";

import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  GitBranch,
  Hand,
  History,
  Image as ImageIcon,
  Lock,
  Maximize2,
  MousePointer2,
  PenTool,
  Play,
  Plus,
  RotateCcw,
  Search,
  ShieldAlert,
  Sparkles,
  StickyNote,
  Trash2,
  Type,
  Unlock,
  X,
  CalendarClock,
  MousePointerClick,
  Webhook,
  MessageSquare,
  RefreshCw,
  Zap,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  api,
  type Agent,
  type Engine,
  type Workflow,
  type WorkflowRun,
  type WorkflowStep,
} from "@/lib/api";
import { cn } from "@/lib/cn";
import { Select } from "@/components/ui/Select";

export interface WorkflowCanvasProps {
  workflow: Workflow;
  workflows: Workflow[];
  agents: Agent[];
  engines: Engine[];
  runs: WorkflowRun[];
  onSelectWorkflow: (id: number) => void;
  onCreateWorkflow: () => void;
  onUpdateWorkflow: (updated: Partial<Workflow>) => Promise<void>;
  onRunWorkflow: () => Promise<void>;
  onClose: () => void;
  onRefreshRuns: () => Promise<void>;
}

type ToolMode = "select" | "pan" | "draw" | "note" | "text" | "search";

export interface NodeSizeLimits {
  defaultWidth: number;
  defaultHeight?: number;
  minWidth: number;
  maxWidth: number;
  minHeight?: number;
  maxHeight?: number;
  resizable: boolean;
}

export const NODE_SIZE_CONFIG: Record<string, NodeSizeLimits> = {
  trigger: {
    defaultWidth: 320,
    minWidth: 280,
    maxWidth: 480,
    resizable: false,
  },
  llm: {
    defaultWidth: 440,
    defaultHeight: 380,
    minWidth: 340,
    maxWidth: 720,
    minHeight: 260,
    maxHeight: 850,
    resizable: true,
  },
  agent: {
    defaultWidth: 440,
    defaultHeight: 380,
    minWidth: 340,
    maxWidth: 720,
    minHeight: 260,
    maxHeight: 850,
    resizable: true,
  },
  action: {
    defaultWidth: 380,
    defaultHeight: 280,
    minWidth: 320,
    maxWidth: 640,
    minHeight: 200,
    maxHeight: 650,
    resizable: true,
  },
  condition: {
    defaultWidth: 360,
    defaultHeight: 240,
    minWidth: 300,
    maxWidth: 540,
    minHeight: 180,
    maxHeight: 500,
    resizable: true,
  },
  approval: {
    defaultWidth: 360,
    defaultHeight: 240,
    minWidth: 300,
    maxWidth: 540,
    minHeight: 180,
    maxHeight: 500,
    resizable: true,
  },
  note: {
    defaultWidth: 300,
    defaultHeight: 200,
    minWidth: 220,
    maxWidth: 600,
    minHeight: 140,
    maxHeight: 600,
    resizable: true,
  },
  end: {
    defaultWidth: 280,
    minWidth: 240,
    maxWidth: 360,
    resizable: false,
  },
};

interface ResizingNodeState {
  stepId: string;
  startPointerX: number;
  startPointerY: number;
  startWidth: number;
  startHeight: number;
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight: number;
}

interface DraggingConnection {
  fromStepId: string;
  fromPort: "out" | "true" | "false" | "approve" | "reject";
  fromDirection?: "output" | "input";
  targetInputPort?: "text" | "image" | "file";
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  snappedTargetId: string | null;
  snappedInputPort?: "text" | "image" | "file";
  snappedOutputPort?: "out" | "true" | "false" | "approve" | "reject";
  validationResult?: ConnectionValidationResult;
}

export type WorkflowPortType = "text" | "image" | "file";

export interface ConnectionValidationResult {
  valid: boolean;
  error?: string;
  sourceType: WorkflowPortType;
  targetType: WorkflowPortType;
}

export function hasPathInWorkflow(
  startId: string,
  endId: string,
  steps: WorkflowStep[]
): boolean {
  if (startId === endId) return true;
  const visited = new Set<string>();
  const queue = [startId];
  visited.add(startId);

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    if (currentId === endId) return true;

    const step = steps.find((s) => s.id === currentId);
    if (!step) continue;

    const neighbors: string[] = [];
    if (step.next_step_id) neighbors.push(step.next_step_id);
    if (step.if_true) neighbors.push(step.if_true);
    if (step.if_false) neighbors.push(step.if_false);
    if (step.on_approve) neighbors.push(step.on_approve);
    if (step.on_reject) neighbors.push(step.on_reject);

    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  return false;
}

export function getOutputPortDataType(
  step: WorkflowStep,
  port: "out" | "true" | "false" | "approve" | "reject"
): WorkflowPortType {
  // Trigger, LLM, Agent, Action, Condition, and Approval output text data
  return "text";
}

export function getInputPortDataType(
  step: WorkflowStep,
  port: "text" | "image" | "file"
): WorkflowPortType {
  return port;
}

export function getOutputPortLabel(
  port: "out" | "true" | "false" | "approve" | "reject"
): string {
  if (port === "true") return "True";
  if (port === "false") return "False";
  if (port === "approve") return "Approve";
  if (port === "reject") return "Reject";
  return "Text";
}

export function validateConnection(
  sourceId: string,
  sourcePort: "out" | "true" | "false" | "approve" | "reject",
  targetId: string,
  targetInputPort: "text" | "image" | "file",
  steps: WorkflowStep[]
): ConnectionValidationResult {
  const sourceStep = steps.find((s) => s.id === sourceId);
  const targetStep = steps.find((s) => s.id === targetId);

  const sourceType = sourceStep ? getOutputPortDataType(sourceStep, sourcePort) : "text";
  const targetType = targetStep ? getInputPortDataType(targetStep, targetInputPort) : targetInputPort;

  // 1. Self connection limitation
  if (sourceId === targetId) {
    return {
      valid: false,
      error: "Cannot connect node to itself",
      sourceType,
      targetType,
    };
  }

  // 2. Already connected
  if (sourceStep) {
    let existingTarget: string | null | undefined = null;
    let existingTargetPort: string | undefined = "text";
    if (sourcePort === "out") {
      existingTarget = sourceStep.next_step_id;
      existingTargetPort = sourceStep.target_port || "text";
    } else if (sourcePort === "true") {
      existingTarget = sourceStep.if_true;
      existingTargetPort = sourceStep.if_true_target_port || "text";
    } else if (sourcePort === "false") {
      existingTarget = sourceStep.if_false;
      existingTargetPort = sourceStep.if_false_target_port || "text";
    } else if (sourcePort === "approve") {
      existingTarget = sourceStep.on_approve;
      existingTargetPort = sourceStep.on_approve_target_port || "text";
    } else if (sourcePort === "reject") {
      existingTarget = sourceStep.on_reject;
      existingTargetPort = sourceStep.on_reject_target_port || "text";
    }

    if (existingTarget === targetId && existingTargetPort === targetInputPort) {
      return {
        valid: false,
        error: "Already connected",
        sourceType,
        targetType,
      };
    }
  }

  // 3. Cyclical connection limitation
  if (hasPathInWorkflow(targetId, sourceId, steps)) {
    return {
      valid: false,
      error: "Cannot create cyclical loop",
      sourceType,
      targetType,
    };
  }

  // 4. Data type compatibility limitation ("Gives text, not image", etc.)
  if (sourceType !== targetType) {
    return {
      valid: false,
      error: `Gives ${sourceType}, not ${targetType}`,
      sourceType,
      targetType,
    };
  }

  return {
    valid: true,
    sourceType,
    targetType,
  };
}

interface FreehandStroke {
  id: string;
  points: Array<{ x: number; y: number }>;
  color: string;
}

interface SelectedWire {
  fromStepId: string;
  toStepId: string;
  port: "out" | "true" | "false" | "approve" | "reject";
}

export function WorkflowCanvas({
  workflow,
  workflows,
  agents,
  engines,
  runs,
  onSelectWorkflow,
  onCreateWorkflow,
  onUpdateWorkflow,
  onRunWorkflow,
  onClose,
  onRefreshRuns,
}: WorkflowCanvasProps) {
  // Canvas viewport navigation
  const [pan, setPan] = useState({ x: 140, y: 80 });
  const [zoom, setZoom] = useState(0.85);
  const [tool, setTool] = useState<ToolMode>("select");
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef({ x: 0, y: 0, panX: 140, panY: 80 });

  // High-performance local node positions map
  const [nodePositions, setNodePositions] = useState<Record<string, { x: number; y: number }>>({});
  const nodePositionsRef = useRef<Record<string, { x: number; y: number }>>({});

  // High-performance dynamic node sizes map
  const [nodeSizes, setNodeSizes] = useState<Record<string, { width: number; height?: number }>>({});
  const nodeSizesRef = useRef<Record<string, { width: number; height?: number }>>({});
  const [resizingNode, setResizingNode] = useState<ResizingNodeState | null>(null);
  const hasResizedNodeRef = useRef(false);

  // Trigger node popover menus
  const [activeTriggerMenuStepId, setActiveTriggerMenuStepId] = useState<string | null>(null);
  const [activeChipMenu, setActiveChipMenu] = useState<{ stepId: string; type: "kind" | "days" | "time" | "hours" } | null>(null);

  // Canvas steps directly from workflow model (no auto-resurrection on delete)
  const effectiveSteps = useMemo(() => {
    return workflow.steps || [];
  }, [workflow.steps]);

  // Exact port Y offset matching each trigger card height
  const getTriggerPortOffsetY = useCallback((step: WorkflowStep): number => {
    const t = step.trigger_type || "schedule";
    if (t === "manual") return 54;
    if (t === "webhook") return 110;
    if (t === "message") return 72;
    if (t === "schedule") {
      if (step.schedule_kind === "cron") return 72;
      return 92;
    }
    return 75;
  }, []);

  // Exact port Y offset for target input ports (matching benchmark stacked ports)
  const getInputPortOffsetY = useCallback(
    (step: WorkflowStep, portType: "text" | "image" | "file" = "text"): number => {
      if (step.type === "llm" || step.type === "agent" || step.type === "action") {
        if (portType === "image") return 82;
        if (portType === "file") return 116;
        return 48; // text
      }
      return 48;
    },
    []
  );

  // Exact port Y offset for source output ports (matching benchmark right ports)
  const getOutputPortOffsetY = useCallback(
    (step: WorkflowStep, port: "out" | "true" | "false" | "approve" | "reject" = "out"): number => {
      if (step.type === "trigger") {
        return getTriggerPortOffsetY(step);
      }
      if (step.type === "condition" || step.type === "approval") {
        return port === "false" || port === "reject" ? 74 : 46;
      }
      return 48;
    },
    [getTriggerPortOffsetY]
  );

  // Helper to find any active wire plugged into a specific input port
  const getIncomingWire = useCallback(
    (targetStepId: string, targetPort: "text" | "image" | "file" = "text") => {
      for (const s of effectiveSteps) {
        if (s.type === "condition") {
          if (s.if_true === targetStepId && (s.if_true_target_port || "text") === targetPort) {
            return { fromStep: s, port: "true" as const };
          }
          if (s.if_false === targetStepId && (s.if_false_target_port || "text") === targetPort) {
            return { fromStep: s, port: "false" as const };
          }
        } else if (s.type === "approval") {
          if (s.on_approve === targetStepId && (s.on_approve_target_port || "text") === targetPort) {
            return { fromStep: s, port: "approve" as const };
          }
          if (s.on_reject === targetStepId && (s.on_reject_target_port || "text") === targetPort) {
            return { fromStep: s, port: "reject" as const };
          }
        } else if (s.type !== "end" && s.type !== "note") {
          if (s.next_step_id === targetStepId && (s.target_port || "text") === targetPort) {
            return { fromStep: s, port: "out" as const };
          }
        }
      }
      return null;
    },
    [effectiveSteps]
  );

  const computeNextRun = useCallback((step: WorkflowStep): string => {
    const now = new Date();
    const kind = step.schedule_kind || "daily";
    const days = step.schedule_days || "every_day";
    const time = step.schedule_time || "09:00";
    const hours = step.schedule_hours || 1;

    if (kind === "hourly") {
      const nextH = new Date(now.getTime() + hours * 3600 * 1000);
      return (
        nextH.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) +
        ", " +
        nextH.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
      );
    }

    const [hStr, mStr] = time.split(":");
    const targetH = parseInt(hStr || "9", 10);
    const targetM = parseInt(mStr || "0", 10);

    const next = new Date(now);
    next.setHours(targetH, targetM, 0, 0);

    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }

    if (kind === "weekly") {
      const dayMap: Record<string, number> = {
        sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6
      };
      const targetDay = dayMap[days.toLowerCase()] ?? 1;
      while (next.getDay() !== targetDay) {
        next.setDate(next.getDate() + 1);
      }
    } else if (kind === "monthly") {
      if (days === "15th") next.setDate(15);
      else if (days === "last") next.setMonth(next.getMonth() + 1, 0);
      else next.setDate(1);
      if (next <= now) {
        next.setMonth(next.getMonth() + 1);
      }
    } else {
      if (days === "weekdays") {
        while (next.getDay() === 0 || next.getDay() === 6) {
          next.setDate(next.getDate() + 1);
        }
      } else if (days === "weekends") {
        while (next.getDay() !== 0 && next.getDay() !== 6) {
          next.setDate(next.getDate() + 1);
        }
      }
    }

    return (
      next.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) +
      ", " +
      next.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
    );
  }, []);

  // Sync positions from effective steps (including trigger node)
  useEffect(() => {
    const next: Record<string, { x: number; y: number }> = {};
    effectiveSteps.forEach((step, idx) => {
      const existing = nodePositionsRef.current[step.id];
      if (existing) {
        next[step.id] = existing;
      } else {
        const defX = step.x !== undefined ? step.x : step.type === "trigger" ? 60 : 440 + (idx % 3) * 380;
        const defY = step.y !== undefined ? step.y : step.type === "trigger" ? 140 : 140 + Math.floor(idx / 3) * 360;
        next[step.id] = { x: defX, y: defY };
      }
    });
    setNodePositions(next);
    nodePositionsRef.current = next;
  }, [workflow.id, effectiveSteps]);

  // Sync sizes from effective steps or fallback to standard benchmark sizes
  useEffect(() => {
    const next: Record<string, { width: number; height?: number }> = {};
    effectiveSteps.forEach((step) => {
      const existing = nodeSizesRef.current[step.id];
      if (existing) {
        next[step.id] = existing;
      } else {
        const cfg = NODE_SIZE_CONFIG[step.type] || NODE_SIZE_CONFIG.llm;
        next[step.id] = {
          width: step.width ?? cfg.defaultWidth,
          ...(step.height || cfg.defaultHeight ? { height: step.height ?? cfg.defaultHeight } : {}),
        };
      }
    });
    setNodeSizes(next);
    nodeSizesRef.current = next;
  }, [workflow.id, effectiveSteps]);

  // Helper to obtain current size & config for a node
  const getNodeSize = useCallback(
    (step: WorkflowStep) => {
      const local = nodeSizes[step.id];
      const cfg = NODE_SIZE_CONFIG[step.type] || NODE_SIZE_CONFIG.llm;
      const width = local?.width ?? step.width ?? cfg.defaultWidth;
      const height = local?.height ?? step.height ?? cfg.defaultHeight;
      return { width, height, cfg };
    },
    [nodeSizes]
  );

  // Initiate bottom-right corner resize gesture
  const handleResizePointerDown = (
    e: React.PointerEvent,
    stepId: string,
    cfg: NodeSizeLimits,
    currentWidth: number,
    currentHeight: number | undefined
  ) => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

    const cardEl = (e.currentTarget as HTMLElement).closest(".workflow-node") as HTMLElement | null;
    const startH = currentHeight ?? (cardEl ? cardEl.offsetHeight : cfg.defaultHeight ?? 300);

    setResizingNode({
      stepId,
      startPointerX: e.clientX,
      startPointerY: e.clientY,
      startWidth: currentWidth,
      startHeight: startH,
      minWidth: cfg.minWidth,
      maxWidth: cfg.maxWidth,
      minHeight: cfg.minHeight ?? 140,
      maxHeight: cfg.maxHeight ?? 900,
    });
    hasResizedNodeRef.current = false;
  };

  // Node selection & dragging
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const dragNodeOffsetRef = useRef({ x: 0, y: 0 });
  const hasMovedNodeRef = useRef(false);
  const [lockedNodes, setLockedNodes] = useState<Set<string>>(new Set());

  // Connection wire dragging & selection
  const [draggingWire, setDraggingWire] = useState<DraggingConnection | null>(null);
  const [hoveredWire, setHoveredWire] = useState<SelectedWire | null>(null);
  const [selectedWire, setSelectedWire] = useState<SelectedWire | null>(null);
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleWirePointerEnter = useCallback((wire: SelectedWire) => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    setHoveredWire(wire);
  }, []);

  const handleWirePointerLeave = useCallback((e: React.PointerEvent) => {
    const related = e.relatedTarget as HTMLElement | null;
    if (related && related.closest && related.closest(".wire-interactive")) return;
    hoverTimeoutRef.current = setTimeout(() => {
      setHoveredWire(null);
    }, 150);
  }, []);

  // Freehand drawing state
  const [strokes, setStrokes] = useState<FreehandStroke[]>([]);
  const [currentStroke, setCurrentStroke] = useState<FreehandStroke | null>(null);

  // UI Panels & menus
  const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [showWorkflowMenu, setShowWorkflowMenu] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState(workflow.name);
  const [expandedOutputStepIds, setExpandedOutputStepIds] = useState<Set<string>>(new Set());
  const [expandedSystemPromptStepIds, setExpandedSystemPromptStepIds] = useState<Set<string>>(new Set());
  const [nodeSearch, setNodeSearch] = useState("");
  const [executionNotice, setExecutionNotice] = useState<string | null>(null);

  // Execution states
  const [runningStepId, setRunningStepId] = useState<string | null>(null);
  const [stepOutputs, setStepOutputs] = useState<Record<string, string>>({});
  const [copiedStepId, setCopiedStepId] = useState<string | null>(null);
  const [liveRun, setLiveRun] = useState<WorkflowRun | null>(null);
  const [isExecutingWorkflow, setIsExecutingWorkflow] = useState(false);

  // Approval notes
  const [approvalNotes, setApprovalNotes] = useState("");
  const [actionBusy, setActionBusy] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);



  // Sync title
  useEffect(() => {
    setTitleInput(workflow.name);
  }, [workflow.name]);

  // Extract available models from engines
  const availableModels = useMemo(() => {
    const list: Array<{ id: string; label: string; provider: string }> = [];
    engines.forEach((eng) => {
      if (eng.models && eng.models.length > 0) {
        eng.models.forEach((m) => {
          list.push({ id: m.id, label: m.label || m.id, provider: eng.label });
        });
      } else {
        list.push({ id: eng.id, label: eng.label, provider: eng.label });
      }
    });
    if (list.length === 0) {
      list.push(
        { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash", provider: "Google" },
        { id: "claude-3-5-sonnet", label: "Claude 3.5 Sonnet", provider: "Anthropic" },
        { id: "gpt-4o", label: "GPT-4o", provider: "OpenAI" }
      );
    }
    return list;
  }, [engines]);

  // Live run polling & completion handling
  useEffect(() => {
    if (!liveRun || liveRun.status === "completed" || liveRun.status === "failed" || liveRun.status === "cancelled") {
      if (liveRun && isExecutingWorkflow) {
        setIsExecutingWorkflow(false);
        setExecutionNotice(
          liveRun.status === "completed"
            ? "Workflow completed successfully!"
            : `Workflow ended with status: ${liveRun.status}`
        );
        setTimeout(() => setExecutionNotice(null), 4000);
        void onRefreshRuns();
      }
      return;
    }

    const timer = setInterval(async () => {
      try {
        const fresh = await api.getWorkflowRun(liveRun.id);
        setLiveRun(fresh);
        if (fresh.step_states) {
          const newOutputs: Record<string, string> = {};
          Object.entries(fresh.step_states).forEach(([sId, state]) => {
            if (state.output) newOutputs[sId] = state.output;
          });
          setStepOutputs((prev) => ({ ...prev, ...newOutputs }));
        }
      } catch {
        // ignore
      }
    }, 600);

    return () => clearInterval(timer);
  }, [liveRun, isExecutingWorkflow, onRefreshRuns]);

  // Keyboard navigation & deletion
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        (e.target as HTMLElement).tagName === "INPUT" ||
        (e.target as HTMLElement).tagName === "TEXTAREA"
      ) {
        return;
      }

      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedNodeId && !lockedNodes.has(selectedNodeId)) {
          e.preventDefault();
          handleDeleteStep(selectedNodeId);
        } else if (selectedWire) {
          e.preventDefault();
          handleDisconnectWire(selectedWire.fromStepId, selectedWire.port);
        }
      } else if (e.key === "Escape") {
        setSelectedNodeId(null);
        setSelectedWire(null);
        setShowAddMenu(false);
        setShowWorkflowMenu(false);
      } else if (e.key === " ") {
        setTool("pan");
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === " ") {
        setTool("select");
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [selectedNodeId, selectedWire, lockedNodes]);

  // Smooth cursor-anchored zoom
  const handleZoom = useCallback((delta: number, clientX?: number, clientY?: number) => {
    setZoom((prevZoom) => {
      const nextZoom = Math.min(2.0, Math.max(0.25, Math.round((prevZoom + delta) * 100) / 100));
      if (clientX !== undefined && clientY !== undefined && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const mouseX = clientX - rect.left;
        const mouseY = clientY - rect.top;
        setPan((prevPan) => ({
          x: mouseX - (mouseX - prevPan.x) * (nextZoom / prevZoom),
          y: mouseY - (mouseY - prevPan.y) * (nextZoom / prevZoom),
        }));
      }
      return nextZoom;
    });
  }, []);

  // Fit to screen (computes bounding box of all nodes)
  const handleFitToScreen = useCallback(() => {
    const allX: number[] = [];
    const allY: number[] = [];

    Object.values(nodePositionsRef.current).forEach((pos) => {
      allX.push(pos.x);
      allY.push(pos.y);
    });

    if (allX.length === 0 || !containerRef.current) return;

    const minX = Math.min(...allX);
    const maxX = Math.max(...allX) + 380;
    const minY = Math.min(...allY);
    const maxY = Math.max(...allY) + 340;

    const width = maxX - minX;
    const height = maxY - minY;

    const clientW = containerRef.current.clientWidth || 1000;
    const clientH = containerRef.current.clientHeight || 700;

    const zoomX = (clientW - 160) / width;
    const zoomY = (clientH - 160) / height;
    const fitZoom = Math.min(1.2, Math.max(0.35, Math.min(zoomX, zoomY)));

    const fitPanX = (clientW - width * fitZoom) / 2 - minX * fitZoom;
    const fitPanY = (clientH - height * fitZoom) / 2 - minY * fitZoom;

    setZoom(Math.round(fitZoom * 100) / 100);
    setPan({ x: Math.round(fitPanX), y: Math.round(fitPanY) });
  }, []);

  // Wheel zoom anchored to pointer
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 0.08 : -0.08;
        handleZoom(delta, e.clientX, e.clientY);
      } else {
        setPan((p) => ({
          x: p.x - e.deltaX,
          y: p.y - e.deltaY,
        }));
      }
    },
    [handleZoom]
  );

  // Background pointer down (Pan / Draw / Deselect)
  const handleCanvasPointerDown = (e: React.PointerEvent) => {
    if (
      (e.target as HTMLElement).closest(".workflow-node") ||
      (e.target as HTMLElement).closest(".ui-dock") ||
      (e.target as HTMLElement).closest(".wire-interactive")
    ) {
      return;
    }

    if (tool === "draw") {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const ptX = (e.clientX - rect.left - pan.x) / zoom;
      const ptY = (e.clientY - rect.top - pan.y) / zoom;
      setCurrentStroke({
        id: `stroke_${Date.now()}`,
        points: [{ x: ptX, y: ptY }],
        color: "#a855f7",
      });
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }

    setIsPanning(true);
    panStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      panX: pan.x,
      panY: pan.y,
    };
    setSelectedNodeId(null);
    setSelectedWire(null);
    setActiveTriggerMenuStepId(null);
    setActiveChipMenu(null);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  // High-performance pointer move (60fps local update)
  const handleCanvasPointerMove = (e: React.PointerEvent) => {
    if (resizingNode) {
      const dx = (e.clientX - resizingNode.startPointerX) / zoom;
      const dy = (e.clientY - resizingNode.startPointerY) / zoom;

      const newWidth = Math.round(
        Math.min(resizingNode.maxWidth, Math.max(resizingNode.minWidth, resizingNode.startWidth + dx))
      );
      const newHeight = Math.round(
        Math.min(resizingNode.maxHeight, Math.max(resizingNode.minHeight, resizingNode.startHeight + dy))
      );

      hasResizedNodeRef.current = true;

      setNodeSizes((prev) => {
        const next = {
          ...prev,
          [resizingNode.stepId]: { width: newWidth, height: newHeight },
        };
        nodeSizesRef.current = next;
        return next;
      });
      return;
    }

    if (currentStroke) {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const ptX = (e.clientX - rect.left - pan.x) / zoom;
      const ptY = (e.clientY - rect.top - pan.y) / zoom;
      setCurrentStroke((prev) =>
        prev ? { ...prev, points: [...prev.points, { x: ptX, y: ptY }] } : null
      );
    } else if (isPanning) {
      const dx = e.clientX - panStartRef.current.x;
      const dy = e.clientY - panStartRef.current.y;
      setPan({
        x: panStartRef.current.panX + dx,
        y: panStartRef.current.panY + dy,
      });
    } else if (draggingNodeId) {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const rawX = (e.clientX - rect.left - pan.x) / zoom;
      const rawY = (e.clientY - rect.top - pan.y) / zoom;

      const newX = Math.round(rawX - dragNodeOffsetRef.current.x);
      const newY = Math.round(rawY - dragNodeOffsetRef.current.y);

      hasMovedNodeRef.current = true;

      setNodePositions((prev) => {
        const next = { ...prev, [draggingNodeId]: { x: newX, y: newY } };
        nodePositionsRef.current = next;
        return next;
      });
    } else if (draggingWire) {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const curX = (e.clientX - rect.left - pan.x) / zoom;
      const curY = (e.clientY - rect.top - pan.y) / zoom;

      if (draggingWire.fromDirection === "input") {
        // Dragging FROM an input port, snapping TO an output port on candidate source nodes
        let snappedSource: string | null = null;
        let snappedOutput: "out" | "true" | "false" | "approve" | "reject" = "out";
        let snapX = curX;
        let snapY = curY;
        let minDistance = 38;

        effectiveSteps.forEach((st) => {
          if (st.id === draggingWire.fromStepId) return;
          if (st.type === "end" || st.type === "note") return; // End and Note have no output ports
          const pos = nodePositions[st.id] || { x: 420, y: 140 };
          const { width: nodeW } = getNodeSize(st);
          const portX = pos.x + nodeW;

          const candidateOutputs: Array<"out" | "true" | "false" | "approve" | "reject"> =
            st.type === "condition"
              ? ["true", "false"]
              : st.type === "approval"
              ? ["approve", "reject"]
              : ["out"];

          for (const p of candidateOutputs) {
            const portY = pos.y + getOutputPortOffsetY(st, p);
            const dist = Math.hypot(curX - portX, curY - portY);
            if (dist < minDistance) {
              minDistance = dist;
              snappedSource = st.id;
              snappedOutput = p;
              snapX = portX;
              snapY = portY;
            }
          }
        });

        const validation = snappedSource
          ? validateConnection(
              snappedSource,
              snappedOutput,
              draggingWire.fromStepId,
              draggingWire.targetInputPort || "text",
              effectiveSteps
            )
          : undefined;

        setDraggingWire((prev) =>
          prev
            ? {
                ...prev,
                currentX: snapX,
                currentY: snapY,
                snappedTargetId: snappedSource,
                snappedOutputPort: snappedSource ? snappedOutput : undefined,
                validationResult: validation,
              }
            : null
        );
      } else {
        // Dragging FROM an output port, snapping TO an input port on candidate target nodes
        let snappedTarget: string | null = null;
        let snappedPort: "text" | "image" | "file" = "text";
        let snapX = curX;
        let snapY = curY;
        let minDistance = 38;

        effectiveSteps.forEach((st) => {
          if (st.id === draggingWire.fromStepId) return;
          if (st.type === "trigger" || st.type === "note") return; // Triggers and Notes have no input ports
          const pos = nodePositions[st.id] || { x: 420, y: 140 };
          const portX = pos.x;

          const candidatePorts: Array<"text" | "image" | "file"> =
            st.type === "llm" || st.type === "agent" || st.type === "action"
              ? ["text", "image", "file"]
              : ["text"];

          for (const p of candidatePorts) {
            const portY = pos.y + getInputPortOffsetY(st, p);
            const dist = Math.hypot(curX - portX, curY - portY);
            if (dist < minDistance) {
              minDistance = dist;
              snappedTarget = st.id;
              snappedPort = p;
              snapX = portX;
              snapY = portY;
            }
          }
        });

        const validation = snappedTarget
          ? validateConnection(
              draggingWire.fromStepId,
              draggingWire.fromPort,
              snappedTarget,
              snappedPort,
              effectiveSteps
            )
          : undefined;

        setDraggingWire((prev) =>
          prev
            ? {
                ...prev,
                currentX: snapX,
                currentY: snapY,
                snappedTargetId: snappedTarget,
                snappedInputPort: snappedTarget ? snappedPort : undefined,
                validationResult: validation,
              }
            : null
        );
      }
    }
  };

  // Drag finish
  const handleCanvasPointerUp = () => {
    if (resizingNode) {
      if (hasResizedNodeRef.current) {
        const finalSize = nodeSizesRef.current[resizingNode.stepId];
        if (finalSize) {
          const updatedSteps = effectiveSteps.map((s) =>
            s.id === resizingNode.stepId
              ? { ...s, width: finalSize.width, height: finalSize.height }
              : s
          );
          void onUpdateWorkflow({ steps: updatedSteps });
        }
      }
      setResizingNode(null);
      hasResizedNodeRef.current = false;
    }

    if (currentStroke) {
      setStrokes((prev) => [...prev, currentStroke]);
      setCurrentStroke(null);
    }
    if (isPanning) setIsPanning(false);

    if (draggingNodeId) {
      if (hasMovedNodeRef.current) {
        const updatedSteps = effectiveSteps.map((s) => {
          const pos = nodePositionsRef.current[s.id];
          return pos ? { ...s, x: pos.x, y: pos.y } : s;
        });
        void onUpdateWorkflow({ steps: updatedSteps });
      }
      setDraggingNodeId(null);
      hasMovedNodeRef.current = false;
    }

    if (draggingWire) {
      if (draggingWire.snappedTargetId) {
        const sourceId =
          draggingWire.fromDirection === "input"
            ? draggingWire.snappedTargetId
            : draggingWire.fromStepId;
        const targetId =
          draggingWire.fromDirection === "input"
            ? draggingWire.fromStepId
            : draggingWire.snappedTargetId;
        const outPort =
          draggingWire.fromDirection === "input"
            ? draggingWire.snappedOutputPort || "out"
            : draggingWire.fromPort;
        const inPort =
          draggingWire.fromDirection === "input"
            ? draggingWire.targetInputPort || "text"
            : draggingWire.snappedInputPort || "text";

        const val = validateConnection(sourceId, outPort, targetId, inPort, effectiveSteps);
        if (val.valid) {
          handleConnect(sourceId, outPort, targetId, inPort);
        }
      }
      setDraggingWire(null);
    }
  };

  // Node pointer down (Supports selection of locked nodes so Unlock action is accessible)
  const handleNodePointerDown = (e: React.PointerEvent, stepId: string) => {
    e.stopPropagation();
    if (tool === "pan") return;

    // Always select the node on click, even if locked
    setSelectedNodeId(stepId);
    setSelectedWire(null);

    // If locked, prevent canvas dragging but keep node selected so toolbar with Unlock is visible
    if (lockedNodes.has(stepId)) return;

    // Allow dragging unless the target is a text input, textarea, or clicking a popover dropdown item
    if (
      (e.target as HTMLElement).tagName === "INPUT" ||
      (e.target as HTMLElement).tagName === "TEXTAREA" ||
      (e.target as HTMLElement).closest(".popover-dropdown")
    ) {
      return;
    }

    setDraggingNodeId(stepId);
    hasMovedNodeRef.current = false;

    const pos = nodePositions[stepId] || { x: 420, y: 140 };
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const rawX = (e.clientX - rect.left - pan.x) / zoom;
    const rawY = (e.clientY - rect.top - pan.y) / zoom;

    dragNodeOffsetRef.current = {
      x: rawX - pos.x,
      y: rawY - pos.y,
    };

    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  // Update a single step property
  const handleUpdateStep = useCallback(
    (stepId: string, partial: Partial<WorkflowStep>) => {
      const base = effectiveSteps;
      const updated = base.map((s) =>
        s.id === stepId ? { ...s, ...partial } : s
      );
      void onUpdateWorkflow({ steps: updated });
    },
    [effectiveSteps, onUpdateWorkflow]
  );

  // Delete a step (supports deleting any node including trigger)
  const handleDeleteStep = useCallback(
    (stepId: string) => {
      const base = effectiveSteps;
      const updated = base.filter((s) => s.id !== stepId);
      const cleaned = updated.map((s) => {
        const next = { ...s };
        if (next.next_step_id === stepId) {
          next.next_step_id = null;
          next.target_port = undefined;
        }
        if (next.if_true === stepId) {
          next.if_true = undefined;
          next.if_true_target_port = undefined;
        }
        if (next.if_false === stepId) {
          next.if_false = undefined;
          next.if_false_target_port = undefined;
        }
        if (next.on_approve === stepId) {
          next.on_approve = undefined;
          next.on_approve_target_port = undefined;
        }
        if (next.on_reject === stepId) {
          next.on_reject = null;
          next.on_reject_target_port = undefined;
        }
        return next;
      });
      setSelectedNodeId(null);
      void onUpdateWorkflow({ steps: cleaned });
    },
    [effectiveSteps, onUpdateWorkflow]
  );

  // Duplicate a step (supports multiple triggers or steps)
  const handleDuplicateStep = useCallback(
    (stepId: string) => {
      const base = effectiveSteps;
      const step = base.find((s) => s.id === stepId);
      if (!step) return;
      const currentPos = nodePositions[stepId] || { x: 420, y: 140 };
      const currentSize = nodeSizesRef.current[stepId] || {
        width: step.width,
        height: step.height,
      };
      const newId = `${step.type === "trigger" ? "trigger" : "step"}_${Date.now().toString(36)}`;
      const newX = currentPos.x + 40;
      const newY = currentPos.y + 40;

      const duplicated: WorkflowStep = {
        ...step,
        id: newId,
        name: `${step.name} (Copy)`,
        x: newX,
        y: newY,
        width: currentSize.width,
        height: currentSize.height,
        next_step_id: null,
      };

      setNodePositions((prev) => {
        const next = { ...prev, [newId]: { x: newX, y: newY } };
        nodePositionsRef.current = next;
        return next;
      });

      if (currentSize.width) {
        setNodeSizes((prev) => {
          const next = {
            ...prev,
            [newId]: { width: currentSize.width, height: currentSize.height },
          };
          nodeSizesRef.current = next;
          return next;
        });
      }

      void onUpdateWorkflow({ steps: [...base, duplicated] });
      setSelectedNodeId(newId);
    },
    [effectiveSteps, nodePositions, onUpdateWorkflow]
  );

  // Toggle lock
  const handleToggleLock = (stepId: string) => {
    setLockedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(stepId)) next.delete(stepId);
      else next.add(stepId);
      return next;
    });
  };

  // Add node from palette
  const handleAddNode = useCallback(
    (type: WorkflowStep["type"], noteColor: string = "amber") => {
      const newId = `step_${Date.now().toString(36)}`;
      const count = (workflow.steps || []).length + 1;
      const clientW = containerRef.current?.clientWidth || 800;
      const clientH = containerRef.current?.clientHeight || 600;
      const centerX = Math.round((-pan.x + clientW / 2) / zoom - 180);
      const centerY = Math.round((-pan.y + clientH / 2) / zoom - 120);

      let newStep: WorkflowStep;
      if (type === "trigger") {
        newStep = {
          id: newId,
          name: `Trigger ${count}`,
          type: "trigger",
          trigger_type: "schedule",
          schedule_kind: "daily",
          schedule_days: "every_day",
          schedule_time: "09:00",
          next_step_id: null,
          x: centerX,
          y: centerY,
        };
      } else if (type === "llm") {
        newStep = {
          id: newId,
          name: `LLM Step ${count}`,
          type: "llm",
          prompt: "Draft a helpful analysis: {{input.message}}",
          model: availableModels[0]?.id || "gemini-2.0-flash",
          effort: "medium",
          x: centerX,
          y: centerY,
        };
      } else if (type === "agent" || type === "action") {
        newStep = {
          id: newId,
          name: `Agent Action ${count}`,
          type: "agent",
          agent_id: agents[0]?.id || 1,
          prompt: "Execute task with instructions: {{input.message}}",
          approval_mode: "ask",
          x: centerX,
          y: centerY,
        };
      } else if (type === "condition") {
        newStep = {
          id: newId,
          name: `Condition ${count}`,
          type: "condition",
          target: "steps.step_1.output",
          operator: "contains",
          value: "approved",
          if_true: "",
          if_false: "",
          x: centerX,
          y: centerY,
        };
      } else if (type === "approval") {
        newStep = {
          id: newId,
          name: `Human Approval ${count}`,
          type: "approval",
          prompt: "Please review and approve this action before proceeding.",
          timeout_minutes: 60,
          on_approve: "",
          on_reject: null,
          x: centerX,
          y: centerY,
        };
      } else if (type === "note") {
        newStep = {
          id: newId,
          name: "Sticky Note",
          type: "note",
          prompt: "Workflow notes and documentation...",
          color: noteColor,
          x: centerX,
          y: centerY,
        };
      } else {
        newStep = {
          id: newId,
          name: `End Step ${count}`,
          type: "end",
          status: "completed",
          message: "Workflow finished successfully.",
          x: centerX,
          y: centerY,
        };
      }

      const cfg = NODE_SIZE_CONFIG[type] || NODE_SIZE_CONFIG.llm;
      newStep.width = cfg.defaultWidth;
      if (cfg.defaultHeight) {
        newStep.height = cfg.defaultHeight;
      }

      setNodePositions((prev) => {
        const next = { ...prev, [newId]: { x: centerX, y: centerY } };
        nodePositionsRef.current = next;
        return next;
      });

      setNodeSizes((prev) => {
        const next = {
          ...prev,
          [newId]: { width: cfg.defaultWidth, height: cfg.defaultHeight },
        };
        nodeSizesRef.current = next;
        return next;
      });

      void onUpdateWorkflow({ steps: [...effectiveSteps, newStep] });
      setSelectedNodeId(newId);
      setShowAddMenu(false);
    },
    [workflow.steps, pan, zoom, agents, availableModels, onUpdateWorkflow]
  );

  // Wire connect logic
  const handleConnect = (
    fromStepId: string,
    fromPort: "out" | "true" | "false" | "approve" | "reject",
    targetStepId: string,
    targetInputPort: "text" | "image" | "file" = "text"
  ) => {
    if (fromStepId === targetStepId) return;

    const val = validateConnection(
      fromStepId,
      fromPort,
      targetStepId,
      targetInputPort,
      effectiveSteps
    );
    if (!val.valid) return;

    const base = effectiveSteps;
    const updated = base.map((s) => {
      if (s.id !== fromStepId) return s;
      const copy = { ...s };
      if (fromPort === "out") {
        copy.next_step_id = targetStepId;
        copy.target_port = targetInputPort;
      } else if (fromPort === "true") {
        copy.if_true = targetStepId;
        copy.if_true_target_port = targetInputPort;
      } else if (fromPort === "false") {
        copy.if_false = targetStepId;
        copy.if_false_target_port = targetInputPort;
      } else if (fromPort === "approve") {
        copy.on_approve = targetStepId;
        copy.on_approve_target_port = targetInputPort;
      } else if (fromPort === "reject") {
        copy.on_reject = targetStepId;
        copy.on_reject_target_port = targetInputPort;
      }
      return copy;
    });
    void onUpdateWorkflow({ steps: updated });
  };

  // Disconnect wire
  const handleDisconnectWire = (fromId: string, port: string) => {
    const updated = effectiveSteps.map((s) => {
      if (s.id !== fromId) return s;
      const copy = { ...s };
      if (port === "out") {
        copy.next_step_id = null;
        copy.target_port = undefined;
      } else if (port === "true") {
        copy.if_true = undefined;
        copy.if_true_target_port = undefined;
      } else if (port === "false") {
        copy.if_false = undefined;
        copy.if_false_target_port = undefined;
      } else if (port === "approve") {
        copy.on_approve = undefined;
        copy.on_approve_target_port = undefined;
      } else if (port === "reject") {
        copy.on_reject = null;
        copy.on_reject_target_port = undefined;
      }
      return copy;
    });
    void onUpdateWorkflow({ steps: updated });
    setSelectedWire(null);
    setHoveredWire(null);
  };

  // Start wire drag from Output port (Right edge)
  const handlePortPointerDown = (
    e: React.PointerEvent,
    stepId: string,
    port: "out" | "true" | "false" | "approve" | "reject",
    portX: number,
    portY: number
  ) => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

    setDraggingWire({
      fromStepId: stepId,
      fromPort: port,
      fromDirection: "output",
      startX: portX,
      startY: portY,
      currentX: portX,
      currentY: portY,
      snappedTargetId: null,
    });
  };

  // Start wire drag / detaching from Input port (Left edge)
  const handleInputPortPointerDown = (
    e: React.PointerEvent,
    stepId: string,
    port: "text" | "image" | "file",
    portX: number,
    portY: number
  ) => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

    // 1. Check if an incoming wire is already plugged into this input port
    const existingIncoming = getIncomingWire(stepId, port);

    if (existingIncoming) {
      const fromStep = existingIncoming.fromStep;
      const fromPort = existingIncoming.port;

      // Select this wire immediately
      setSelectedWire({
        fromStepId: fromStep.id,
        toStepId: stepId,
        port: fromPort,
      });

      // Detach the connection from this port and begin dragging from source output
      const srcPos = nodePositions[fromStep.id] || { x: 420, y: 140 };
      const { width: srcW } = getNodeSize(fromStep);
      const srcX = srcPos.x + srcW;
      const srcY = srcPos.y + getOutputPortOffsetY(fromStep, fromPort);

      handleDisconnectWire(fromStep.id, fromPort);

      setDraggingWire({
        fromStepId: fromStep.id,
        fromPort: fromPort,
        fromDirection: "output",
        startX: srcX,
        startY: srcY,
        currentX: portX,
        currentY: portY,
        snappedTargetId: null,
      });
      return;
    }

    // 2. Otherwise start reverse drag from this input port to an output port
    setDraggingWire({
      fromStepId: stepId,
      fromPort: "out",
      fromDirection: "input",
      targetInputPort: port,
      startX: portX,
      startY: portY,
      currentX: portX,
      currentY: portY,
      snappedTargetId: null,
    });
  };

  // Control points calculation for cubic Bezier curve with forward & backward loop handling
  const getCurveControlPoints = (x1: number, y1: number, x2: number, y2: number) => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    let cx1: number, cy1: number, cx2: number, cy2: number;
    if (dx >= 0) {
      const cx = Math.max(40, dx * 0.5);
      cx1 = x1 + cx;
      cy1 = y1;
      cx2 = x2 - cx;
      cy2 = y2;
    } else {
      // Smooth backward loop when target is behind source
      const cx = Math.max(50, Math.min(180, Math.abs(dx) * 0.6));
      const cy = Math.abs(dy) < 40 ? 40 : Math.min(100, Math.abs(dy) * 0.4);
      const signY = dy >= 0 ? 1 : -1;
      cx1 = x1 + cx;
      cy1 = y1 + cy * signY;
      cx2 = x2 - cx;
      cy2 = y2 - cy * signY;
    }
    return { cx1, cy1, cx2, cy2 };
  };

  const getCurvePath = (x1: number, y1: number, x2: number, y2: number) => {
    const { cx1, cy1, cx2, cy2 } = getCurveControlPoints(x1, y1, x2, y2);
    return `M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`;
  };

  const getCurveMidpoint = (x1: number, y1: number, x2: number, y2: number) => {
    const { cx1, cy1, cx2, cy2 } = getCurveControlPoints(x1, y1, x2, y2);
    const midX = 0.125 * x1 + 0.375 * cx1 + 0.375 * cx2 + 0.125 * x2;
    const midY = 0.125 * y1 + 0.375 * cy1 + 0.375 * cy2 + 0.125 * y2;
    return { midX, midY };
  };

  // Execute workflow live across canvas
  const handleTriggerFullRun = async () => {
    try {
      setIsExecutingWorkflow(true);
      await onRunWorkflow();
      const run = await api.startWorkflowRun(
        workflow.id,
        { message: "Triggered from visual canvas" },
        true
      );
      setLiveRun(run);
      setSelectedRunId(run.id);
      await onRefreshRuns();
    } catch (err) {
      setIsExecutingWorkflow(false);
      alert(`Run failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Run isolated step
  const handleRunStep = async (stepId: string) => {
    try {
      setRunningStepId(stepId);
      const res = await api.runWorkflowStep(workflow.id, stepId, {
        ...stepOutputs,
        message: "Step test from canvas",
      });
      setStepOutputs((prev) => ({
        ...prev,
        [stepId]: res.output || "Step completed.",
      }));
      setExpandedOutputStepIds((prev) => new Set(prev).add(stepId));
    } catch (err) {
      setStepOutputs((prev) => ({
        ...prev,
        [stepId]: `Error: ${err instanceof Error ? err.message : String(err)}`,
      }));
      setExpandedOutputStepIds((prev) => new Set(prev).add(stepId));
    } finally {
      setRunningStepId(null);
    }
  };

  // Resolve human approval
  const handleResolveApproval = async (decision: "approve" | "reject") => {
    if (!liveRun) return;
    try {
      setActionBusy(true);
      await api.approveWorkflowRun(liveRun.id, decision, approvalNotes.trim() || undefined);
      setApprovalNotes("");
      const fresh = await api.getWorkflowRun(liveRun.id);
      setLiveRun(fresh);
      await onRefreshRuns();
    } catch (err) {
      alert(`Approval error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setActionBusy(false);
    }
  };

  const activeRun = useMemo(() => {
    if (selectedRunId) return runs.find((r) => r.id === selectedRunId) || liveRun || runs[0] || null;
    return liveRun || runs[0] || null;
  }, [runs, selectedRunId, liveRun]);

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-[#0b0c0e] text-zinc-100 select-none overflow-hidden font-sans">
      {/* Top Floating Completion Notice */}
      {executionNotice && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-emerald-950/95 border border-emerald-500/80 text-emerald-300 px-4 py-2 rounded-xl text-xs font-semibold shadow-2xl z-50 animate-in fade-in slide-in-from-top duration-200">
          <CheckCircle2 size={15} />
          <span>{executionNotice}</span>
        </div>
      )}

      {/* Top Navigation Bar */}
      <header className="h-14 border-b border-zinc-800/80 bg-[#101116]/95 backdrop-blur-md px-4 flex items-center justify-between shrink-0 z-50">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onClose}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
            title="Return to conversation"
          >
            <ArrowLeft size={16} />
            <span>Chat</span>
          </button>

          <div className="h-4 w-px bg-zinc-800" />

          {/* Engine indicator */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-zinc-900 border border-zinc-700/60 text-xs font-medium text-zinc-200">
            <span className="w-2 h-2 rounded-full bg-emerald-500 shadow-sm shadow-emerald-500/80 animate-pulse" />
            <span>Local</span>
            <ChevronDown size={13} className="text-zinc-500" />
          </div>

          {/* Undo / Redo */}
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-zinc-800/80 disabled:opacity-30"
              title="Undo"
            >
              <RotateCcw size={14} />
            </button>
          </div>

          {/* Workflow Title Switcher */}
          <div className="relative">
            {editingTitle ? (
              <input
                type="text"
                value={titleInput}
                autoFocus
                onChange={(e) => setTitleInput(e.target.value)}
                onBlur={() => {
                  setEditingTitle(false);
                  if (titleInput.trim() && titleInput !== workflow.name) {
                    void onUpdateWorkflow({ name: titleInput.trim() });
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    setEditingTitle(false);
                    if (titleInput.trim() && titleInput !== workflow.name) {
                      void onUpdateWorkflow({ name: titleInput.trim() });
                    }
                  } else if (e.key === "Escape") {
                    setTitleInput(workflow.name);
                    setEditingTitle(false);
                  }
                }}
                className="bg-zinc-900 border border-zinc-700 rounded-md px-2 py-0.5 text-sm font-semibold text-white focus:outline-none focus:ring-1 focus:ring-accent"
              />
            ) : (
              <button
                type="button"
                onClick={() => setShowWorkflowMenu(!showWorkflowMenu)}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-sm font-semibold text-zinc-100 hover:bg-zinc-800/80 transition-colors"
              >
                <span>{workflow.name}</span>
                <ChevronDown size={14} className="text-zinc-400" />
              </button>
            )}

            {/* Switcher Dropdown */}
            {showWorkflowMenu && (
              <div className="absolute top-full left-0 mt-1 w-64 rounded-xl border border-zinc-800 bg-zinc-900/98 shadow-2xl backdrop-blur-md p-1.5 z-50">
                <div className="px-2 py-1 text-[10px] font-bold text-zinc-500 uppercase tracking-wider">
                  Workflows
                </div>
                <div className="max-h-56 overflow-y-auto space-y-0.5">
                  {workflows.map((wf) => (
                    <button
                      key={wf.id}
                      type="button"
                      onClick={() => {
                        onSelectWorkflow(wf.id);
                        setShowWorkflowMenu(false);
                      }}
                      className={cn(
                        "w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center justify-between",
                        wf.id === workflow.id
                          ? "bg-zinc-800 text-white font-medium"
                          : "text-zinc-300 hover:bg-zinc-800/60"
                      )}
                    >
                      <span className="truncate">{wf.name}</span>
                      {wf.id === workflow.id && <Check size={12} className="text-accent" />}
                    </button>
                  ))}
                </div>
                <div className="h-px bg-zinc-800 my-1" />
                <button
                  type="button"
                  onClick={() => {
                    setShowWorkflowMenu(false);
                    onCreateWorkflow();
                  }}
                  className="w-full text-left px-2.5 py-1.5 rounded-lg text-xs font-medium text-accent hover:bg-zinc-800/80 flex items-center gap-1.5"
                >
                  <Plus size={14} />
                  <span>New workflow</span>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Top Right Controls */}
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => setHistoryDrawerOpen(!historyDrawerOpen)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors",
              historyDrawerOpen
                ? "bg-zinc-800 text-white border-zinc-700"
                : "text-zinc-300 border-zinc-800 hover:bg-zinc-800/60 hover:text-white"
            )}
          >
            <History size={14} />
            <span>History</span>
            <span className="px-1.5 py-0.2 rounded-full bg-zinc-800 text-[10px] text-zinc-400 font-bold border border-zinc-700">
              {runs.length}
            </span>
          </button>

          <button
            type="button"
            disabled={isExecutingWorkflow}
            onClick={handleTriggerFullRun}
            className="flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-semibold bg-white text-zinc-950 hover:bg-zinc-100 shadow-md transition-all active:scale-95 disabled:opacity-50"
          >
            {isExecutingWorkflow ? (
              <span className="w-3.5 h-3.5 border-2 border-zinc-950 border-t-transparent rounded-full animate-spin" />
            ) : (
              <Play size={13} className="fill-zinc-950" />
            )}
            <span>{isExecutingWorkflow ? "Running..." : "Run workflow"}</span>
          </button>
        </div>
      </header>

      {/* Main 2D Canvas Workspace */}
      <div
        ref={containerRef}
        onWheel={handleWheel}
        onPointerDown={handleCanvasPointerDown}
        onPointerMove={handleCanvasPointerMove}
        onPointerUp={handleCanvasPointerUp}
        className={cn(
          "relative flex-1 w-full h-full overflow-hidden select-none",
          resizingNode
            ? "cursor-nwse-resize"
            : tool === "pan" || isPanning
            ? "cursor-grab active:cursor-grabbing"
            : tool === "draw"
            ? "cursor-crosshair"
            : "cursor-default"
        )}
        style={{
          backgroundColor: "#0d0e12",
          backgroundImage: `radial-gradient(circle, rgba(255, 255, 255, 0.08) 1.2px, transparent 1.2px)`,
          backgroundSize: `${24 * zoom}px ${24 * zoom}px`,
          backgroundPosition: `${pan.x}px ${pan.y}px`,
        }}
      >
        {/* Left Section Pill Badge (Benchmark style) */}
        <div className="absolute top-4 left-4 z-30 flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#16171d]/90 border border-zinc-800 text-xs font-semibold text-zinc-300 shadow-xl backdrop-blur-md">
          <GitBranch size={13} className="text-zinc-400" />
          <span>Workflows</span>
        </div>

        {/* Transformable Canvas Root Layer */}
        <div
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: "0 0",
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
          }}
        >
          {/* Freehand Strokes Layer */}
          <svg className="absolute inset-0 w-[10000px] h-[10000px] pointer-events-none -z-10">
            {strokes.map((st) => (
              <path
                key={st.id}
                d={st.points.reduce((acc, p, i) => `${acc} ${i === 0 ? "M" : "L"} ${p.x} ${p.y}`, "")}
                fill="none"
                stroke={st.color}
                strokeWidth={3}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}
            {currentStroke && (
              <path
                d={currentStroke.points.reduce((acc, p, i) => `${acc} ${i === 0 ? "M" : "L"} ${p.x} ${p.y}`, "")}
                fill="none"
                stroke={currentStroke.color}
                strokeWidth={3}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
          </svg>

          {/* SVG Connection Wires Layer */}
          <svg className="absolute inset-0 w-[10000px] h-[10000px] overflow-visible pointer-events-none z-[1]">
            <style>{`
              @keyframes wireFlow {
                to { stroke-dashoffset: -24; }
              }
              .wire-animating {
                animation: wireFlow 1s linear infinite;
              }
            `}</style>

            {/* Node-to-Node Connections */}
            {effectiveSteps.map((step) => {
              const srcPos = nodePositions[step.id] || { x: 420, y: 140 };
              const { width: nodeW } = getNodeSize(step);
              const srcX = srcPos.x + nodeW;

              const renderWire = (
                targetId: string,
                port: "out" | "true" | "false" | "approve" | "reject",
                targetPort: "text" | "image" | "file" = "text",
                color: string = "rgba(255, 255, 255, 0.35)"
              ) => {
                const targetStep = effectiveSteps.find((s) => s.id === targetId);
                const targetPos = nodePositions[targetId] || { x: 420, y: 140 };
                const srcY = srcPos.y + getOutputPortOffsetY(step, port);
                const tgtX = targetPos.x;
                const tgtY = targetPos.y + (targetStep ? getInputPortOffsetY(targetStep, targetPort) : 48);
                const isCurrentActive =
                  isExecutingWorkflow && liveRun?.current_step_id === targetId;
                const isSelected =
                  selectedWire?.fromStepId === step.id && selectedWire?.toStepId === targetId;
                const isHovered =
                  hoveredWire?.fromStepId === step.id && hoveredWire?.toStepId === targetId;
                const isSelectedOrHovered = isSelected || isHovered;

                const pathData = getCurvePath(srcX, srcY, tgtX, tgtY);
                const { midX, midY } = getCurveMidpoint(srcX, srcY, tgtX, tgtY);

                return (
                  <g
                    key={`${step.id}-${port}-${targetId}`}
                    className="wire-interactive pointer-events-auto cursor-pointer group"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedWire({ fromStepId: step.id, toStepId: targetId, port });
                    }}
                    onPointerEnter={() =>
                      handleWirePointerEnter({ fromStepId: step.id, toStepId: targetId, port })
                    }
                    onPointerLeave={handleWirePointerLeave}
                  >
                    {/* Transparent fat hit-test path for easy hovering/clicking */}
                    <path d={pathData} fill="none" stroke="transparent" strokeWidth={28} />

                    {/* Visible Wire */}
                    <path
                      d={pathData}
                      fill="none"
                      stroke={
                        isSelectedOrHovered
                          ? "#ef4444"
                          : isCurrentActive
                          ? "#a855f7"
                          : color
                      }
                      strokeWidth={isSelectedOrHovered ? 2.5 : isCurrentActive ? 3 : 2}
                      strokeDasharray="4 4"
                      className={isCurrentActive ? "wire-animating" : ""}
                    />

                    {/* Midpoint Disconnect Button (Matching Benchmark Red Circular 'X') */}
                    {isSelectedOrHovered && (
                      <g
                        transform={`translate(${midX}, ${midY})`}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          handleDisconnectWire(step.id, port);
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          handleDisconnectWire(step.id, port);
                        }}
                        className="cursor-pointer group/btn"
                      >
                        {/* Generous invisible hit-circle for effortless clicking */}
                        <circle r={20} fill="transparent" />
                        <circle
                          r={12}
                          fill="#ef4444"
                          stroke="#991b1b"
                          strokeWidth={1.5}
                          className="group-hover/btn:scale-125 transition-transform duration-150 drop-shadow-md"
                        />
                        <line x1={-4} y1={-4} x2={4} y2={4} stroke="#ffffff" strokeWidth={2.5} strokeLinecap="round" />
                        <line x1={4} y1={-4} x2={-4} y2={4} stroke="#ffffff" strokeWidth={2.5} strokeLinecap="round" />
                      </g>
                    )}
                  </g>
                );
              };

              const elements: React.ReactNode[] = [];

              if (step.type !== "condition" && step.type !== "approval" && step.next_step_id) {
                elements.push(
                  renderWire(step.next_step_id, "out", step.target_port || "text", "rgba(255, 255, 255, 0.35)")
                );
              }
              if (step.type === "condition") {
                if (step.if_true) elements.push(renderWire(step.if_true, "true", step.if_true_target_port || "text", "#10b981"));
                if (step.if_false) elements.push(renderWire(step.if_false, "false", step.if_false_target_port || "text", "#f59e0b"));
              }
              if (step.type === "approval") {
                if (step.on_approve)
                  elements.push(renderWire(step.on_approve, "approve", step.on_approve_target_port || "text", "#10b981"));
                if (step.on_reject)
                  elements.push(renderWire(step.on_reject, "reject", step.on_reject_target_port || "text", "#ef4444"));
              }

              return <g key={`wires-${step.id}`}>{elements}</g>;
            })}

            {/* Currently Dragged Elastic Wire */}
            {draggingWire && (() => {
              const x1 =
                draggingWire.fromDirection === "input"
                  ? draggingWire.currentX
                  : draggingWire.startX;
              const y1 =
                draggingWire.fromDirection === "input"
                  ? draggingWire.currentY
                  : draggingWire.startY;
              const x2 =
                draggingWire.fromDirection === "input"
                  ? draggingWire.startX
                  : draggingWire.currentX;
              const y2 =
                draggingWire.fromDirection === "input"
                  ? draggingWire.startY
                  : draggingWire.currentY;

              const pathData = getCurvePath(x1, y1, x2, y2);
              const isSnapped = !!draggingWire.snappedTargetId;
              const isInvalid =
                isSnapped &&
                draggingWire.validationResult &&
                !draggingWire.validationResult.valid;
              const isValid =
                isSnapped &&
                (!draggingWire.validationResult ||
                  draggingWire.validationResult.valid);

              const strokeColor = isInvalid
                ? "#ef4444"
                : isValid
                ? "#10b981"
                : "rgba(255, 255, 255, 0.4)";

              return (
                <path
                  d={pathData}
                  fill="none"
                  stroke={strokeColor}
                  strokeWidth={2.5}
                  strokeDasharray="5 4"
                  className={isValid ? "wire-animating" : ""}
                />
              );
            })()}

            {/* Freehand Pencil Drawing Layer */}
            {strokes.map((st) => (
              <path
                key={st.id}
                d={st.points.map((p, idx) => `${idx === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ")}
                fill="none"
                stroke={st.color || "#a855f7"}
                strokeWidth={3}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}
            {currentStroke && currentStroke.points.length > 0 && (
              <path
                d={currentStroke.points.map((p, idx) => `${idx === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ")}
                fill="none"
                stroke={currentStroke.color || "#a855f7"}
                strokeWidth={3}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
          </svg>

          {/* Connection Limitation Badge on Dragged Wire ("Gives text, not image", etc.) */}
          {draggingWire &&
            draggingWire.snappedTargetId &&
            draggingWire.validationResult &&
            !draggingWire.validationResult.valid && (() => {
              const x1 =
                draggingWire.fromDirection === "input"
                  ? draggingWire.currentX
                  : draggingWire.startX;
              const y1 =
                draggingWire.fromDirection === "input"
                  ? draggingWire.currentY
                  : draggingWire.startY;
              const x2 =
                draggingWire.fromDirection === "input"
                  ? draggingWire.startX
                  : draggingWire.currentX;
              const y2 =
                draggingWire.fromDirection === "input"
                  ? draggingWire.startY
                  : draggingWire.currentY;
              const { midX, midY } = getCurveMidpoint(x1, y1, x2, y2);

              return (
                <div
                  style={{
                    left: `${midX}px`,
                    top: `${midY}px`,
                  }}
                  className="absolute pointer-events-none -translate-x-1/2 -translate-y-1/2 px-3 py-1 rounded-full bg-[#18181b] border border-red-500/90 shadow-xl shadow-black/80 text-red-400 text-xs font-medium whitespace-nowrap z-50 select-none animate-in fade-in zoom-in-95 duration-100 flex items-center justify-center"
                >
                  {draggingWire.validationResult.error}
                </div>
              );
            })()}

          {/* Workflow Canvas Nodes (including draggable Trigger nodes) */}
          {effectiveSteps.map((step) => {
            const pos = nodePositions[step.id] || { x: 420, y: 140 };
            const isSelected = selectedNodeId === step.id;
            const isLocked = lockedNodes.has(step.id);
            const isRunningThis =
              runningStepId === step.id || (isExecutingWorkflow && liveRun?.current_step_id === step.id);
            const stepRunState = liveRun?.step_states?.[step.id];
            const isCompleted = stepRunState?.status === "completed";
            const outputText = stepOutputs[step.id] || stepRunState?.output;
            const isOutputExpanded = expandedOutputStepIds.has(step.id);
            const isTargetSnapped = draggingWire?.snappedTargetId === step.id;
            const { width: nodeW, height: nodeH, cfg } = getNodeSize(step);
            const isResizingThis = resizingNode?.stepId === step.id;
            const isDraggingThis = draggingNodeId === step.id;

            return (
              <div
                key={step.id}
                style={{
                  transform: `translate(${pos.x}px, ${pos.y}px)`,
                  position: "absolute",
                  touchAction: "none",
                  width: `${nodeW}px`,
                  height: nodeH ? `${nodeH}px` : undefined,
                  minWidth: `${cfg.minWidth}px`,
                  maxWidth: `${cfg.maxWidth}px`,
                  minHeight: cfg.minHeight ? `${cfg.minHeight}px` : undefined,
                  maxHeight: cfg.maxHeight ? `${cfg.maxHeight}px` : undefined,
                  transition:
                    isResizingThis || isDraggingThis
                      ? "none"
                      : "width 0.18s cubic-bezier(0.16, 1, 0.3, 1), height 0.18s cubic-bezier(0.16, 1, 0.3, 1), border-color 0.15s ease, box-shadow 0.2s cubic-bezier(0.16, 1, 0.3, 1)",
                }}
                onPointerDownCapture={() => {
                  setSelectedNodeId(step.id);
                  setSelectedWire(null);
                }}
                onPointerDown={(e) => handleNodePointerDown(e, step.id)}
                className={cn(
                  "workflow-node rounded-2xl border shadow-2xl backdrop-blur-md p-4 flex flex-col gap-3 transition-shadow z-10",
                  step.type === "note"
                    ? (step.color === "neutral" || step.color === "white"
                        ? "bg-[#22242c]/95 border-zinc-600/60 text-zinc-100"
                        : step.color === "emerald"
                        ? "bg-[#092419]/95 border-emerald-600/60 text-emerald-100"
                        : step.color === "rose"
                        ? "bg-[#2d0e19]/95 border-rose-600/60 text-rose-100"
                        : step.color === "blue"
                        ? "bg-[#0c1f35]/95 border-blue-600/60 text-blue-100"
                        : "bg-[#291b0a]/95 border-amber-600/60 text-amber-100")
                    : "bg-[#16171d]",
                  isSelected
                    ? "border-zinc-300 ring-2 ring-zinc-300/20"
                    : isRunningThis
                    ? "border-purple-500 shadow-purple-500/20 ring-2 ring-purple-500/30 animate-pulse"
                    : isTargetSnapped
                    ? "border-emerald-400 ring-2 ring-emerald-400/40"
                    : step.type === "note"
                    ? ""
                    : "border-zinc-800/90 hover:border-zinc-700/80"
                )}
              >
                {/* Benchmark-matching Node Category Indicator above the card */}
                <div className="absolute -top-5 left-1 flex items-center gap-1.5 text-zinc-400 font-medium text-[11px] select-none pointer-events-none">
                  {step.type === "trigger" ? (
                    <>
                      <Zap size={11} className="text-amber-400 fill-amber-400" />
                      <span>Trigger</span>
                    </>
                  ) : step.type === "llm" ? (
                    <>
                      <Sparkles size={11} className="text-purple-400" />
                      <span>LLM</span>
                    </>
                  ) : step.type === "agent" || step.type === "action" ? (
                    <>
                      <Bot size={11} className="text-blue-400" />
                      <span>Agent</span>
                    </>
                  ) : step.type === "condition" ? (
                    <>
                      <GitBranch size={11} className="text-amber-400" />
                      <span>Condition</span>
                    </>
                  ) : step.type === "approval" ? (
                    <>
                      <ShieldAlert size={11} className="text-rose-400" />
                      <span>Approval</span>
                    </>
                  ) : step.type === "note" ? (
                    <>
                      <StickyNote size={11} className="text-yellow-400" />
                      <span>Note</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle2 size={11} className="text-emerald-400" />
                      <span>End</span>
                    </>
                  )}
                </div>

                {/* Floating Action Bar above selected node (Matches workflow NodeToolbar) */}
                {isSelected && (
                  <div
                    className="absolute -top-11 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-[#1a1b22] border border-zinc-700 rounded-xl px-2 py-1 shadow-2xl z-30"
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      disabled={isLocked}
                      onClick={() => handleDuplicateStep(step.id)}
                      className="p-1.5 text-zinc-400 hover:text-white rounded-lg hover:bg-zinc-800 transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
                      title="Duplicate node"
                    >
                      <Copy size={13} />
                    </button>
                    <div className="w-[1px] h-3 bg-zinc-700/60 mx-0.5" />
                    <button
                      type="button"
                      onClick={() => handleToggleLock(step.id)}
                      className={cn(
                        "p-1.5 rounded-lg transition-colors",
                        isLocked ? "text-amber-400 bg-amber-500/10 hover:bg-amber-500/20" : "text-zinc-400 hover:text-white hover:bg-zinc-800"
                      )}
                      title={isLocked ? "Unlock node" : "Lock node"}
                    >
                      {isLocked ? <Lock size={13} /> : <Unlock size={13} />}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteStep(step.id)}
                      className="p-1.5 text-rose-400 hover:text-rose-300 rounded-lg hover:bg-zinc-800 transition-colors"
                      title="Delete node"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                )}

                {/* Interactive Curved Corner Resize Handle (conforming to rounded-2xl bottom-right arc) */}
                {isSelected && !isLocked && cfg.resizable && (
                  <div
                    onPointerDown={(e) =>
                      handleResizePointerDown(e, step.id, cfg, nodeW, nodeH)
                    }
                    onPointerMove={handleCanvasPointerMove}
                    onPointerUp={handleCanvasPointerUp}
                    className="absolute -bottom-1 -right-1 w-7 h-7 flex items-end justify-end p-1.5 cursor-nwse-resize z-30 group/resize select-none"
                    title="Drag to resize"
                  >
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 15 15"
                      fill="none"
                      className="text-white/85 group-hover/resize:text-white group-hover/resize:scale-110 group-active/resize:scale-125 transition-transform drop-shadow"
                    >
                      <path
                        d="M 2 13 C 7 13 13 7 13 2"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                      />
                    </svg>
                  </div>
                )}

                {/* Left Input Ports (Triggers and Notes have no left input ports) */}
                {step.type !== "note" && step.type !== "trigger" && (
                  <>
                    {step.type === "llm" || step.type === "agent" || step.type === "action" ? (
                      <>
                        {/* 1. Text Input Port (T) */}
                        {(() => {
                          const incoming = getIncomingWire(step.id, "text");
                          const isSnapped =
                            (draggingWire?.fromDirection !== "input" &&
                              isTargetSnapped &&
                              (draggingWire?.snappedInputPort === "text" || !draggingWire?.snappedInputPort)) ||
                            (draggingWire?.fromDirection === "input" &&
                              draggingWire?.fromStepId === step.id &&
                              (draggingWire?.targetInputPort === "text" || !draggingWire?.targetInputPort));
                          const isInvalid =
                            isSnapped &&
                            draggingWire?.snappedTargetId &&
                            draggingWire?.validationResult &&
                            !draggingWire.validationResult.valid;
                          const isValid =
                            isSnapped &&
                            draggingWire?.snappedTargetId &&
                            (!draggingWire?.validationResult || draggingWire.validationResult.valid);
                          const isReverseDraggingThis =
                            draggingWire?.fromDirection === "input" &&
                            draggingWire?.fromStepId === step.id &&
                            (draggingWire?.targetInputPort === "text" || !draggingWire?.targetInputPort);

                          return (
                            <div
                              style={{ top: "48px" }}
                              onPointerDown={(e) =>
                                handleInputPortPointerDown(e, step.id, "text", pos.x, pos.y + 48)
                              }
                              onClick={(e) => {
                                e.stopPropagation();
                                if (incoming) {
                                  setSelectedWire({
                                    fromStepId: incoming.fromStep.id,
                                    toStepId: step.id,
                                    port: incoming.port,
                                  });
                                }
                              }}
                              className={cn(
                                "absolute -left-[11px] -translate-y-1/2 w-[22px] h-[22px] rounded-full bg-[#18181b] border transition-all cursor-crosshair flex items-center justify-center z-20 text-[10px] font-mono font-bold select-none shadow-md",
                                isInvalid
                                  ? "border-zinc-300 ring-2 ring-white bg-zinc-800 text-white scale-125 shadow-lg"
                                  : isValid
                                  ? "border-emerald-400 bg-emerald-950 text-emerald-300 scale-125 ring-4 ring-emerald-500/40 shadow-lg"
                                  : isReverseDraggingThis
                                  ? "border-white bg-zinc-800 text-white scale-115"
                                  : incoming
                                  ? "border-zinc-400 text-zinc-100 bg-zinc-800 hover:border-white hover:scale-115"
                                  : "border-zinc-600/90 text-zinc-400 hover:border-white hover:text-white hover:scale-115 hover:bg-zinc-800"
                              )}
                              title={
                                incoming
                                  ? `Connected from ${incoming.fromStep.name} (${incoming.port}). Click to select, or drag to re-route`
                                  : "Text input (variables & prompt template). Drag to connect"
                              }
                            >
                              T
                              {isReverseDraggingThis && (
                                <div className="absolute right-[calc(100%+8px)] top-1/2 -translate-y-1/2 px-2 py-0.5 rounded-md bg-[#18181b] border border-zinc-700 text-zinc-100 text-[11px] font-medium whitespace-nowrap shadow-md pointer-events-none select-none z-30">
                                  Text
                                </div>
                              )}
                            </div>
                          );
                        })()}

                        {/* 2. Image Input Port (ImageIcon) */}
                        {(() => {
                          const incoming = getIncomingWire(step.id, "image");
                          const isSnapped =
                            (draggingWire?.fromDirection !== "input" &&
                              isTargetSnapped &&
                              draggingWire?.snappedInputPort === "image") ||
                            (draggingWire?.fromDirection === "input" &&
                              draggingWire?.fromStepId === step.id &&
                              draggingWire?.targetInputPort === "image");
                          const isInvalid =
                            isSnapped &&
                            draggingWire?.snappedTargetId &&
                            draggingWire?.validationResult &&
                            !draggingWire.validationResult.valid;
                          const isValid =
                            isSnapped &&
                            draggingWire?.snappedTargetId &&
                            (!draggingWire?.validationResult || draggingWire.validationResult.valid);
                          const isReverseDraggingThis =
                            draggingWire?.fromDirection === "input" &&
                            draggingWire?.fromStepId === step.id &&
                            draggingWire?.targetInputPort === "image";

                          return (
                            <div
                              style={{ top: "82px" }}
                              onPointerDown={(e) =>
                                handleInputPortPointerDown(e, step.id, "image", pos.x, pos.y + 82)
                              }
                              onClick={(e) => {
                                e.stopPropagation();
                                if (incoming) {
                                  setSelectedWire({
                                    fromStepId: incoming.fromStep.id,
                                    toStepId: step.id,
                                    port: incoming.port,
                                  });
                                }
                              }}
                              className={cn(
                                "absolute -left-[11px] -translate-y-1/2 w-[22px] h-[22px] rounded-full bg-[#18181b] border transition-all cursor-crosshair flex items-center justify-center z-20 select-none shadow-md",
                                isInvalid
                                  ? "border-zinc-300 ring-2 ring-white bg-zinc-800 text-white scale-125 shadow-lg"
                                  : isValid
                                  ? "border-emerald-400 bg-emerald-950 text-emerald-300 scale-125 ring-4 ring-emerald-500/40 shadow-lg"
                                  : isReverseDraggingThis
                                  ? "border-white bg-zinc-800 text-white scale-115"
                                  : incoming
                                  ? "border-zinc-400 text-zinc-100 bg-zinc-800 hover:border-white hover:scale-115"
                                  : "border-zinc-600/90 text-zinc-400 hover:border-white hover:text-white hover:scale-115 hover:bg-zinc-800"
                              )}
                              title={
                                incoming
                                  ? `Connected from ${incoming.fromStep.name} (${incoming.port}). Click to select, or drag to re-route`
                                  : "Image input (vision context). Drag to connect"
                              }
                            >
                              <ImageIcon size={11} strokeWidth={2} />
                              {isReverseDraggingThis && (
                                <div className="absolute right-[calc(100%+8px)] top-1/2 -translate-y-1/2 px-2 py-0.5 rounded-md bg-[#18181b] border border-zinc-700 text-zinc-100 text-[11px] font-medium whitespace-nowrap shadow-md pointer-events-none select-none z-30">
                                  Image
                                </div>
                              )}
                            </div>
                          );
                        })()}

                        {/* 3. File Input Port (FileText) */}
                        {(() => {
                          const incoming = getIncomingWire(step.id, "file");
                          const isSnapped =
                            (draggingWire?.fromDirection !== "input" &&
                              isTargetSnapped &&
                              draggingWire?.snappedInputPort === "file") ||
                            (draggingWire?.fromDirection === "input" &&
                              draggingWire?.fromStepId === step.id &&
                              draggingWire?.targetInputPort === "file");
                          const isInvalid =
                            isSnapped &&
                            draggingWire?.snappedTargetId &&
                            draggingWire?.validationResult &&
                            !draggingWire.validationResult.valid;
                          const isValid =
                            isSnapped &&
                            draggingWire?.snappedTargetId &&
                            (!draggingWire?.validationResult || draggingWire.validationResult.valid);
                          const isReverseDraggingThis =
                            draggingWire?.fromDirection === "input" &&
                            draggingWire?.fromStepId === step.id &&
                            draggingWire?.targetInputPort === "file";

                          return (
                            <div
                              style={{ top: "116px" }}
                              onPointerDown={(e) =>
                                handleInputPortPointerDown(e, step.id, "file", pos.x, pos.y + 116)
                              }
                              onClick={(e) => {
                                e.stopPropagation();
                                if (incoming) {
                                  setSelectedWire({
                                    fromStepId: incoming.fromStep.id,
                                    toStepId: step.id,
                                    port: incoming.port,
                                  });
                                }
                              }}
                              className={cn(
                                "absolute -left-[11px] -translate-y-1/2 w-[22px] h-[22px] rounded-full bg-[#18181b] border transition-all cursor-crosshair flex items-center justify-center z-20 select-none shadow-md",
                                isInvalid
                                  ? "border-zinc-300 ring-2 ring-white bg-zinc-800 text-white scale-125 shadow-lg"
                                  : isValid
                                  ? "border-emerald-400 bg-emerald-950 text-emerald-300 scale-125 ring-4 ring-emerald-500/40 shadow-lg"
                                  : isReverseDraggingThis
                                  ? "border-white bg-zinc-800 text-white scale-115"
                                  : incoming
                                  ? "border-zinc-400 text-zinc-100 bg-zinc-800 hover:border-white hover:scale-115"
                                  : "border-zinc-600/90 text-zinc-400 hover:border-white hover:text-white hover:scale-115 hover:bg-zinc-800"
                              )}
                              title={
                                incoming
                                  ? `Connected from ${incoming.fromStep.name} (${incoming.port}). Click to select, or drag to re-route`
                                  : "File input (document & code context). Drag to connect"
                              }
                            >
                              <FileText size={11} strokeWidth={2} />
                              {isReverseDraggingThis && (
                                <div className="absolute right-[calc(100%+8px)] top-1/2 -translate-y-1/2 px-2 py-0.5 rounded-md bg-[#18181b] border border-zinc-700 text-zinc-100 text-[11px] font-medium whitespace-nowrap shadow-md pointer-events-none select-none z-30">
                                  File
                                </div>
                              )}
                            </div>
                          );
                        })()}
                      </>
                    ) : (
                      /* Single Input Port for Condition, Approval, End */
                      (() => {
                        const incoming = getIncomingWire(step.id, "text");
                        const isSnapped =
                          (draggingWire?.fromDirection !== "input" && isTargetSnapped) ||
                          (draggingWire?.fromDirection === "input" &&
                            draggingWire?.fromStepId === step.id &&
                            (draggingWire?.targetInputPort === "text" || !draggingWire?.targetInputPort));
                        const isInvalid =
                          isSnapped &&
                          draggingWire?.snappedTargetId &&
                          draggingWire?.validationResult &&
                          !draggingWire.validationResult.valid;
                        const isValid =
                          isSnapped &&
                          draggingWire?.snappedTargetId &&
                          (!draggingWire?.validationResult || draggingWire.validationResult.valid);
                        const isReverseDraggingThis =
                          draggingWire?.fromDirection === "input" &&
                          draggingWire?.fromStepId === step.id &&
                          (draggingWire?.targetInputPort === "text" || !draggingWire?.targetInputPort);

                        return (
                          <div
                            style={{ top: "48px" }}
                            onPointerDown={(e) =>
                              handleInputPortPointerDown(e, step.id, "text", pos.x, pos.y + 48)
                            }
                            onClick={(e) => {
                              e.stopPropagation();
                              if (incoming) {
                                setSelectedWire({
                                  fromStepId: incoming.fromStep.id,
                                  toStepId: step.id,
                                  port: incoming.port,
                                });
                              }
                            }}
                            className={cn(
                              "absolute -left-[11px] -translate-y-1/2 w-[22px] h-[22px] rounded-full bg-[#18181b] border transition-all cursor-crosshair flex items-center justify-center z-20 text-[10px] font-mono font-bold select-none shadow-md",
                              isInvalid
                                ? "border-zinc-300 ring-2 ring-white bg-zinc-800 text-white scale-125 shadow-lg"
                                : isValid
                                ? "border-emerald-400 bg-emerald-950 text-emerald-300 scale-125 ring-4 ring-emerald-500/40 shadow-lg"
                                : isReverseDraggingThis
                                ? "border-white bg-zinc-800 text-white scale-115"
                                : incoming
                                ? "border-zinc-400 text-zinc-100 bg-zinc-800 hover:border-white hover:scale-115"
                                : "border-zinc-600/90 text-zinc-400 hover:border-white hover:text-white hover:scale-115 hover:bg-zinc-800"
                            )}
                            title={
                              incoming
                                ? `Connected from ${incoming.fromStep.name} (${incoming.port}). Click to select, or drag to re-route`
                                : step.type === "end"
                                ? "Flow completion input. Drag to connect"
                                : "Input data. Drag to connect"
                            }
                          >
                            {step.type === "end" ? (
                              <CheckCircle2 size={11} className="text-emerald-400" />
                            ) : (
                              "T"
                            )}
                            {isReverseDraggingThis && (
                              <div className="absolute right-[calc(100%+8px)] top-1/2 -translate-y-1/2 px-2 py-0.5 rounded-md bg-[#18181b] border border-zinc-700 text-zinc-100 text-[11px] font-medium whitespace-nowrap shadow-md pointer-events-none select-none z-30">
                                Text
                              </div>
                            )}
                          </div>
                        );
                      })()
                    )}
                  </>
                )}

                {/* Node Title & Status Header for non-trigger nodes */}
                {step.type !== "trigger" && (
                  <div className="flex items-center justify-between text-xs cursor-grab active:cursor-grabbing select-none" data-drag-handle="true">
                    <div className="flex items-center gap-2">
                      {step.type === "llm" && <Sparkles size={15} className="text-purple-400" />}
                      {(step.type === "agent" || step.type === "action") && (
                        <Bot size={15} className="text-blue-400" />
                      )}
                      {step.type === "condition" && <GitBranch size={15} className="text-amber-400" />}
                      {step.type === "approval" && <ShieldAlert size={15} className="text-rose-400" />}
                      {step.type === "note" && <StickyNote size={15} className="text-yellow-400" />}
                      {step.type === "end" && <CheckCircle2 size={15} className="text-emerald-400" />}

                      <span className="font-semibold text-zinc-200 text-xs">
                        {step.type === "llm"
                          ? "LLM"
                          : step.type === "agent" || step.type === "action"
                          ? "Agent"
                          : step.type === "condition"
                          ? "Condition"
                          : step.type === "approval"
                          ? "Approval"
                          : step.type === "note"
                          ? "Note"
                          : "End"}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5">
                      {isLocked && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleToggleLock(step.id);
                          }}
                          className="flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-amber-500/10 text-amber-300 border border-amber-500/30 text-[10px] font-medium hover:bg-amber-500/20 transition-colors"
                          title="Click to unlock"
                        >
                          <Lock size={10} />
                          <span>Unlock</span>
                        </button>
                      )}
                      {step.type === "llm" && (
                        <span className="text-[11px] font-mono text-zinc-500">{step.id}</span>
                      )}
                      {isRunningThis ? (
                        <span className="flex items-center gap-1 text-[11px] text-purple-400 font-medium">
                          <span className="w-2 h-2 rounded-full bg-purple-400 animate-ping" />
                          Running...
                        </span>
                      ) : isCompleted ? (
                        <span className="flex items-center gap-1 text-[11px] text-emerald-400 font-medium">
                          <CheckCircle2 size={12} />
                          Done
                        </span>
                      ) : null}
                    </div>
                  </div>
                )}

                {/* Trigger Node Form (Matches workflow WorkflowTriggerNode options) */}
                {step.type === "trigger" && (
                  <div className="flex flex-col gap-3">
                    {/* Trigger Top Header Row with Trigger Type & Status */}
                    <div className="flex items-center justify-between gap-2">
                      <div className="relative flex-1">
                        <button
                          type="button"
                          disabled={isLocked}
                          onClick={(e) => {
                            e.stopPropagation();
                            setActiveTriggerMenuStepId(activeTriggerMenuStepId === step.id ? null : step.id);
                          }}
                          className="w-full flex items-center justify-between px-3 py-1.5 rounded-xl bg-zinc-900/90 border border-zinc-700/80 text-xs font-semibold text-zinc-200 hover:bg-zinc-800 transition-colors shadow-sm disabled:opacity-50"
                        >
                          <div className="flex items-center gap-2">
                            {step.trigger_type === "manual" ? (
                              <div className="w-5 h-5 rounded-md bg-blue-500/20 text-blue-400 flex items-center justify-center">
                                <MousePointerClick size={13} />
                              </div>
                            ) : step.trigger_type === "webhook" ? (
                              <div className="w-5 h-5 rounded-md bg-emerald-500/20 text-emerald-400 flex items-center justify-center">
                                <Webhook size={13} />
                              </div>
                            ) : step.trigger_type === "message" ? (
                              <div className="w-5 h-5 rounded-md bg-purple-500/20 text-purple-400 flex items-center justify-center">
                                <MessageSquare size={13} />
                              </div>
                            ) : (
                              <div className="w-5 h-5 rounded-md bg-amber-500/20 text-amber-400 flex items-center justify-center">
                                <CalendarClock size={13} />
                              </div>
                            )}
                            <span className="capitalize">{step.trigger_type || "Schedule"}</span>
                          </div>
                          <ChevronDown size={13} className="text-zinc-400" />
                        </button>

                        {/* Dropdown Menu for Trigger Type */}
                        {activeTriggerMenuStepId === step.id && !isLocked && (
                          <div className="popover-dropdown absolute top-full left-0 mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-900/98 shadow-2xl p-1.5 z-50 flex flex-col gap-0.5 backdrop-blur-md">
                            {[
                              { id: "schedule", label: "Schedule", icon: CalendarClock, color: "text-amber-400" },
                              { id: "manual", label: "Manual", icon: MousePointerClick, color: "text-blue-400" },
                              { id: "webhook", label: "Webhook", icon: Webhook, color: "text-emerald-400" },
                              { id: "message", label: "Chat Message", icon: MessageSquare, color: "text-purple-400" },
                            ].map((tItem) => {
                              const TIcon = tItem.icon;
                              return (
                                <button
                                  key={tItem.id}
                                  type="button"
                                  onClick={() => {
                                    handleUpdateStep(step.id, { trigger_type: tItem.id as "manual" | "schedule" | "webhook" | "message" });
                                    setActiveTriggerMenuStepId(null);
                                  }}
                                  className={cn(
                                    "w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center justify-between transition-colors",
                                    (step.trigger_type || "schedule") === tItem.id
                                      ? "bg-zinc-800 text-white font-medium"
                                      : "text-zinc-300 hover:bg-zinc-800/60"
                                  )}
                                >
                                  <div className="flex items-center gap-2">
                                    <TIcon size={14} className={tItem.color} />
                                    <span>{tItem.label}</span>
                                  </div>
                                  {(step.trigger_type || "schedule") === tItem.id && (
                                    <Check size={12} className="text-accent" />
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        {isLocked && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleToggleLock(step.id);
                            }}
                            className="flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-amber-500/10 text-amber-300 border border-amber-500/30 text-[10px] font-medium hover:bg-amber-500/20 transition-colors"
                            title="Click to unlock"
                          >
                            <Lock size={10} />
                            <span>Unlock</span>
                          </button>
                        )}
                        {isRunningThis ? (
                          <span className="flex items-center gap-1 text-[11px] text-purple-400 font-medium">
                            <span className="w-2 h-2 rounded-full bg-purple-400 animate-ping" />
                            Running...
                          </span>
                        ) : isCompleted ? (
                          <span className="flex items-center gap-1 text-[11px] text-emerald-400 font-medium">
                            <CheckCircle2 size={12} />
                            Done
                          </span>
                        ) : null}
                      </div>
                    </div>

                    {/* Schedule Configuration (Matching workflow RoutineSchedulePicker Sentence Chips) */}
                    {(step.trigger_type || "schedule") === "schedule" && (
                      <div className="flex flex-col gap-2.5 pt-0.5">
                        <div className="flex items-center flex-wrap gap-1.5 text-xs text-zinc-400">
                          {/* Frequency Chip */}
                          <div className="relative">
                            <button
                              type="button"
                              disabled={isLocked}
                              onClick={(e) => {
                                e.stopPropagation();
                                setActiveChipMenu(
                                  activeChipMenu?.stepId === step.id && activeChipMenu?.type === "kind"
                                    ? null
                                    : { stepId: step.id, type: "kind" }
                                );
                              }}
                              className="px-2.5 py-1 rounded-lg bg-zinc-800/90 hover:bg-zinc-700 text-zinc-100 font-medium text-xs flex items-center gap-1 border border-zinc-700/60 transition-colors disabled:opacity-50"
                            >
                              <span className="capitalize">{step.schedule_kind || "Daily"}</span>
                              <ChevronDown size={11} className="text-zinc-400" />
                            </button>
                            {activeChipMenu?.stepId === step.id && activeChipMenu?.type === "kind" && !isLocked && (
                              <div className="popover-dropdown absolute top-full left-0 mt-1 w-28 rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl p-1 z-50 flex flex-col gap-0.5">
                                {["daily", "hourly", "weekly", "monthly", "cron"].map((k) => (
                                  <button
                                    key={k}
                                    type="button"
                                    onClick={() => {
                                      handleUpdateStep(step.id, { schedule_kind: k as "daily" | "hourly" | "weekly" | "monthly" | "cron" });
                                      setActiveChipMenu(null);
                                    }}
                                    className="w-full text-left px-2 py-1 rounded-lg text-xs capitalize hover:bg-zinc-800 text-zinc-200"
                                  >
                                    {k}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>

                          {/* Daily settings */}
                          {(step.schedule_kind || "daily") === "daily" && (
                            <>
                              <span className="text-zinc-500 font-normal">on</span>
                              <div className="relative">
                                <button
                                  type="button"
                                  disabled={isLocked}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setActiveChipMenu(
                                      activeChipMenu?.stepId === step.id && activeChipMenu?.type === "days"
                                        ? null
                                        : { stepId: step.id, type: "days" }
                                    );
                                  }}
                                  className="px-2.5 py-1 rounded-lg bg-zinc-800/90 hover:bg-zinc-700 text-zinc-100 font-medium text-xs flex items-center gap-1 border border-zinc-700/60 transition-colors disabled:opacity-50"
                                >
                                  <span>
                                    {step.schedule_days === "weekdays"
                                      ? "Weekdays"
                                      : step.schedule_days === "weekends"
                                      ? "Weekends"
                                      : "Every day"}
                                  </span>
                                  <ChevronDown size={11} className="text-zinc-400" />
                                </button>
                                {activeChipMenu?.stepId === step.id && activeChipMenu?.type === "days" && !isLocked && (
                                  <div className="popover-dropdown absolute top-full left-0 mt-1 w-32 rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl p-1 z-50 flex flex-col gap-0.5">
                                    {[
                                      { id: "every_day", label: "Every day" },
                                      { id: "weekdays", label: "Weekdays" },
                                      { id: "weekends", label: "Weekends" },
                                    ].map((d) => (
                                      <button
                                        key={d.id}
                                        type="button"
                                        onClick={() => {
                                          handleUpdateStep(step.id, { schedule_days: d.id });
                                          setActiveChipMenu(null);
                                        }}
                                        className="w-full text-left px-2 py-1 rounded-lg text-xs hover:bg-zinc-800 text-zinc-200"
                                      >
                                        {d.label}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                              <span className="text-zinc-500 font-normal">at</span>
                              <div className="relative">
                                <button
                                  type="button"
                                  disabled={isLocked}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setActiveChipMenu(
                                      activeChipMenu?.stepId === step.id && activeChipMenu?.type === "time"
                                        ? null
                                        : { stepId: step.id, type: "time" }
                                    );
                                  }}
                                  className="px-2.5 py-1 rounded-lg bg-zinc-800/90 hover:bg-zinc-700 text-zinc-100 font-medium text-xs flex items-center gap-1 border border-zinc-700/60 transition-colors disabled:opacity-50"
                                >
                                  <span>
                                    {step.schedule_time === "09:00"
                                      ? "9 AM"
                                      : step.schedule_time || "9 AM"}
                                  </span>
                                  <ChevronDown size={11} className="text-zinc-400" />
                                </button>
                                {activeChipMenu?.stepId === step.id && activeChipMenu?.type === "time" && !isLocked && (
                                  <div className="absolute top-full left-0 mt-1 w-28 max-h-48 overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl p-1 z-50 flex flex-col gap-0.5">
                                    {[
                                      "06:00", "07:00", "08:00", "09:00", "10:00", "11:00",
                                      "12:00", "13:00", "14:00", "15:00", "16:00", "17:00",
                                      "18:00", "19:00", "20:00", "21:00"
                                    ].map((tVal) => {
                                      const h = parseInt(tVal.split(":")[0], 10);
                                      const ampm = h >= 12 ? "PM" : "AM";
                                      const h12 = h % 12 || 12;
                                      const label = `${h12} ${ampm}`;
                                      return (
                                        <button
                                          key={tVal}
                                          type="button"
                                          onClick={() => {
                                            handleUpdateStep(step.id, { schedule_time: tVal });
                                            setActiveChipMenu(null);
                                          }}
                                          className="w-full text-left px-2 py-1 rounded-lg text-xs hover:bg-zinc-800 text-zinc-200"
                                        >
                                          {label}
                                        </button>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            </>
                          )}

                          {/* Hourly settings */}
                          {step.schedule_kind === "hourly" && (
                            <>
                              <span className="text-zinc-500 font-normal">every</span>
                              <div className="relative">
                                <button
                                  type="button"
                                  disabled={isLocked}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setActiveChipMenu(
                                      activeChipMenu?.stepId === step.id && activeChipMenu?.type === "hours"
                                        ? null
                                        : { stepId: step.id, type: "hours" }
                                    );
                                  }}
                                  className="px-2.5 py-1 rounded-lg bg-zinc-800/90 hover:bg-zinc-700 text-zinc-100 font-medium text-xs flex items-center gap-1 border border-zinc-700/60 transition-colors disabled:opacity-50"
                                >
                                  <span>{step.schedule_hours || 1} hour{(step.schedule_hours || 1) > 1 ? "s" : ""}</span>
                                  <ChevronDown size={11} className="text-zinc-400" />
                                </button>
                                {activeChipMenu?.stepId === step.id && activeChipMenu?.type === "hours" && !isLocked && (
                                  <div className="absolute top-full left-0 mt-1 w-28 rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl p-1 z-50 flex flex-col gap-0.5">
                                    {[1, 2, 4, 6, 12].map((hr) => (
                                      <button
                                        key={hr}
                                        type="button"
                                        onClick={() => {
                                          handleUpdateStep(step.id, { schedule_hours: hr });
                                          setActiveChipMenu(null);
                                        }}
                                        className="w-full text-left px-2 py-1 rounded-lg text-xs hover:bg-zinc-800 text-zinc-200"
                                      >
                                        {hr} hour{hr > 1 ? "s" : ""}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </>
                          )}

                          {/* Weekly settings */}
                          {step.schedule_kind === "weekly" && (
                            <>
                              <span className="text-zinc-500 font-normal">on</span>
                              <div className="relative">
                                <button
                                  type="button"
                                  disabled={isLocked}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setActiveChipMenu(
                                      activeChipMenu?.stepId === step.id && activeChipMenu?.type === "days"
                                        ? null
                                        : { stepId: step.id, type: "days" }
                                    );
                                  }}
                                  className="px-2.5 py-1 rounded-lg bg-zinc-800/90 hover:bg-zinc-700 text-zinc-100 font-medium text-xs flex items-center gap-1 border border-zinc-700/60 transition-colors disabled:opacity-50"
                                >
                                  <span className="capitalize">{step.schedule_days || "Monday"}</span>
                                  <ChevronDown size={11} className="text-zinc-400" />
                                </button>
                                {activeChipMenu?.stepId === step.id && activeChipMenu?.type === "days" && !isLocked && (
                                  <div className="popover-dropdown absolute top-full left-0 mt-1 w-32 rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl p-1 z-50 flex flex-col gap-0.5">
                                    {["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((wDay) => (
                                      <button
                                        key={wDay}
                                        type="button"
                                        onClick={() => {
                                          handleUpdateStep(step.id, { schedule_days: wDay.toLowerCase() });
                                          setActiveChipMenu(null);
                                        }}
                                        className="w-full text-left px-2 py-1 rounded-lg text-xs hover:bg-zinc-800 text-zinc-200"
                                      >
                                        {wDay}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                              <span className="text-zinc-500 font-normal">at</span>
                              <div className="relative">
                                <button
                                  type="button"
                                  disabled={isLocked}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setActiveChipMenu(
                                      activeChipMenu?.stepId === step.id && activeChipMenu?.type === "time"
                                        ? null
                                        : { stepId: step.id, type: "time" }
                                    );
                                  }}
                                  className="px-2.5 py-1 rounded-lg bg-zinc-800/90 hover:bg-zinc-700 text-zinc-100 font-medium text-xs flex items-center gap-1 border border-zinc-700/60 transition-colors disabled:opacity-50"
                                >
                                  <span>{step.schedule_time || "9 AM"}</span>
                                  <ChevronDown size={11} className="text-zinc-400" />
                                </button>
                              </div>
                            </>
                          )}

                          {/* Monthly settings */}
                          {step.schedule_kind === "monthly" && (
                            <>
                              <span className="text-zinc-500 font-normal">on day</span>
                              <div className="relative">
                                <button
                                  type="button"
                                  disabled={isLocked}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setActiveChipMenu(
                                      activeChipMenu?.stepId === step.id && activeChipMenu?.type === "days"
                                        ? null
                                        : { stepId: step.id, type: "days" }
                                    );
                                  }}
                                  className="px-2.5 py-1 rounded-lg bg-zinc-800/90 hover:bg-zinc-700 text-zinc-100 font-medium text-xs flex items-center gap-1 border border-zinc-700/60 transition-colors disabled:opacity-50"
                                >
                                  <span>{step.schedule_days === "15th" ? "15th" : step.schedule_days === "last" ? "Last day" : "1st"}</span>
                                  <ChevronDown size={11} className="text-zinc-400" />
                                </button>
                                {activeChipMenu?.stepId === step.id && activeChipMenu?.type === "days" && !isLocked && (
                                  <div className="absolute top-full left-0 mt-1 w-28 rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl p-1 z-50 flex flex-col gap-0.5">
                                    {[
                                      { id: "1st", label: "1st" },
                                      { id: "15th", label: "15th" },
                                      { id: "last", label: "Last day" },
                                    ].map((mDay) => (
                                      <button
                                        key={mDay.id}
                                        type="button"
                                        onClick={() => {
                                          handleUpdateStep(step.id, { schedule_days: mDay.id });
                                          setActiveChipMenu(null);
                                        }}
                                        className="w-full text-left px-2 py-1 rounded-lg text-xs hover:bg-zinc-800 text-zinc-200"
                                      >
                                        {mDay.label}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                              <span className="text-zinc-500 font-normal">at</span>
                              <div className="relative">
                                <button
                                  type="button"
                                  disabled={isLocked}
                                  className="px-2.5 py-1 rounded-lg bg-zinc-800/90 text-zinc-100 font-medium text-xs flex items-center gap-1 border border-zinc-700/60"
                                >
                                  <span>{step.schedule_time || "9 AM"}</span>
                                </button>
                              </div>
                            </>
                          )}

                          {/* Cron settings */}
                          {step.schedule_kind === "cron" && (
                            <input
                              type="text"
                              disabled={isLocked}
                              value={step.schedule_cron || "0 9 * * 1-5"}
                              placeholder="0 9 * * 1-5"
                              onChange={(e) => handleUpdateStep(step.id, { schedule_cron: e.target.value })}
                              className="bg-zinc-950 border border-zinc-700 rounded-lg px-2 py-1 text-xs text-zinc-200 font-mono w-32 focus:outline-none disabled:opacity-50"
                            />
                          )}
                        </div>

                        {/* Next Run Row (Matching workflow nextRun view) */}
                        <div className="flex items-center justify-between text-xs pt-1 px-1 border-t border-zinc-800/70">
                          <span className="text-zinc-500 text-[11px] font-normal">Next run</span>
                          <span className="text-zinc-300 text-[11px] font-medium font-sans">
                            {computeNextRun(step)}
                          </span>
                        </div>
                      </div>
                    )}

                    {/* Manual Info */}
                    {step.trigger_type === "manual" && (
                      <div className="text-[11px] text-zinc-400 bg-zinc-900/60 rounded-xl p-2 border border-zinc-800/80 leading-relaxed">
                        Starts manually when you click Run workflow or trigger via API.
                      </div>
                    )}

                    {/* Webhook Info (Matching workflow RoutineWebhookEndpoint) */}
                    {step.trigger_type === "webhook" && (
                      <div className="flex flex-col gap-2 pt-0.5 text-xs">
                        <div className="flex flex-col gap-1">
                          <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">Webhook Address</span>
                          <div className="flex items-center gap-1.5 bg-zinc-950 rounded-lg p-1.5 border border-zinc-800">
                            <span className="truncate font-mono text-[11px] text-zinc-300 flex-1" title={`http://localhost:8000/api/v1/workflows/${workflow.id}/trigger`}>
                              {`http://localhost:8000/api/v1/workflows/${workflow.id}/trigger`}
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                navigator.clipboard.writeText(`http://localhost:8000/api/v1/workflows/${workflow.id}/trigger`);
                                setExecutionNotice("Webhook URL copied to clipboard!");
                                setTimeout(() => setExecutionNotice(null), 3000);
                              }}
                              className="p-1 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
                              title="Copy Webhook Address"
                            >
                              <Copy size={12} />
                            </button>
                          </div>
                        </div>

                        <div className="flex flex-col gap-1">
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">Signing Secret</span>
                            <button
                              type="button"
                              disabled={isLocked}
                              onClick={() => {
                                const newSecret = `whsec_${Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
                                handleUpdateStep(step.id, { webhook_secret: newSecret });
                                setExecutionNotice("Signing secret regenerated!");
                                setTimeout(() => setExecutionNotice(null), 3000);
                              }}
                              className="text-[10px] text-zinc-400 hover:text-white flex items-center gap-1 transition-colors disabled:opacity-40"
                              title="Rotate secret"
                            >
                              <RefreshCw size={10} /> Rotate
                            </button>
                          </div>
                          <div className="flex items-center gap-1.5 bg-zinc-950 rounded-lg p-1.5 border border-zinc-800">
                            <span className="truncate font-mono text-[11px] text-zinc-400 flex-1">
                              {step.webhook_secret || "whsec_live_9a7b2c4e6f801"}
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                navigator.clipboard.writeText(step.webhook_secret || "whsec_live_9a7b2c4e6f801");
                                setExecutionNotice("Secret copied to clipboard!");
                                setTimeout(() => setExecutionNotice(null), 3000);
                              }}
                              className="p-1 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
                              title="Copy Secret"
                            >
                              <Copy size={12} />
                            </button>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Chat Message Info */}
                    {step.trigger_type === "message" && (
                      <div className="flex flex-col gap-1 pt-0.5 text-xs">
                        <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">Chat Keyword</span>
                        <input
                          type="text"
                          disabled={isLocked}
                          value={step.message_keyword || ""}
                          placeholder="e.g. #workflow or /run"
                          onChange={(e) => handleUpdateStep(step.id, { message_keyword: e.target.value })}
                          className="bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-xs text-zinc-200 focus:outline-none disabled:opacity-50"
                        />
                        <span className="text-[10px] text-zinc-500">Runs automatically when chat message starts with this keyword.</span>
                      </div>
                    )}

                    {/* Primary Trigger Button: Run now / Run workflow / Send test webhook */}
                    <button
                      type="button"
                      disabled={isLocked || isExecutingWorkflow}
                      onClick={() => handleTriggerFullRun()}
                      className="w-full py-1.5 px-3 rounded-xl bg-white text-zinc-950 font-semibold text-xs flex items-center justify-center gap-1.5 hover:bg-zinc-200 transition-colors shadow-sm disabled:opacity-50 active:scale-98"
                    >
                      {isExecutingWorkflow ? (
                        <span className="w-3 h-3 border-2 border-zinc-950 border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <Play size={12} className="fill-zinc-950" />
                      )}
                      <span>
                        {isExecutingWorkflow
                          ? "Running..."
                          : step.trigger_type === "manual"
                          ? "Run workflow"
                          : step.trigger_type === "webhook"
                          ? "Send test webhook"
                          : "Run now"}
                      </span>
                    </button>
                  </div>
                )}

                {/* LLM & Agent Form */}
                {(step.type === "llm" || step.type === "agent" || step.type === "action") && (
                  <div className="flex-1 min-h-0 flex flex-col justify-between gap-3">
                    <div className="flex-1 min-h-0 flex flex-col gap-3">
                      <textarea
                        value={step.prompt || ""}
                        placeholder={step.type === "llm" ? "Type your prompt here" : "Tell the agent what to do"}
                        onChange={(e) => handleUpdateStep(step.id, { prompt: e.target.value })}
                        className="w-full flex-1 min-h-[70px] bg-transparent border-none text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none resize-none font-sans leading-relaxed"
                      />

                      {/* Bottom Controls Row */}
                      <div className="flex items-center justify-between gap-2 pt-2 border-t border-zinc-800/80 text-xs shrink-0">
                        {step.type === "llm" ? (
                          <Select
                            value={step.model || availableModels[0]?.id || "gemini-2.0-flash"}
                            onChange={(e) => handleUpdateStep(step.id, { model: e.target.value })}
                            containerClassName="w-auto max-w-[200px]"
                            triggerClassName="h-7 !py-1 !px-2.5 text-xs rounded-lg bg-zinc-800/90 border-zinc-700/80 hover:bg-zinc-700 text-zinc-200"
                            menuClassName="bg-zinc-900 border-zinc-700 text-zinc-200 z-50 max-h-56"
                            options={availableModels.map((m) => ({
                              value: m.id,
                              label: (
                                <div className="flex items-center justify-between gap-3 w-full">
                                  <span className="truncate">{m.label}</span>
                                  <span className="text-[10px] text-zinc-500 shrink-0">{m.provider}</span>
                                </div>
                              ),
                            }))}
                          />
                        ) : (
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {/* Agent Select */}
                            <Select
                              value={String(step.agent_id || agents[0]?.id || 1)}
                              onChange={(e) => handleUpdateStep(step.id, { agent_id: Number(e.target.value) })}
                              containerClassName="w-auto max-w-[150px]"
                              triggerClassName="h-7 !py-1 !px-2.5 text-xs rounded-lg bg-zinc-800/90 border-zinc-700/80 hover:bg-zinc-700 text-zinc-200"
                              menuClassName="bg-zinc-900 border-zinc-700 text-zinc-200 z-50 max-h-56"
                              leadingIcon={<span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />}
                              options={agents.map((ag) => ({
                                value: String(ag.id),
                                label: (
                                  <div className="flex items-center gap-2 truncate">
                                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                                    <span className="truncate">{ag.name}</span>
                                  </div>
                                ),
                              }))}
                            />

                            {/* Agent Model Select */}
                            <Select
                              value={step.model || availableModels[0]?.id || "gemini-2.0-flash"}
                              onChange={(e) => handleUpdateStep(step.id, { model: e.target.value })}
                              containerClassName="w-auto max-w-[160px]"
                              triggerClassName="h-7 !py-1 !px-2.5 text-xs rounded-lg bg-zinc-800/90 border-zinc-700/80 hover:bg-zinc-700 text-zinc-300"
                              menuClassName="bg-zinc-900 border-zinc-700 text-zinc-200 z-50 max-h-56"
                              leadingIcon={<Sparkles size={11} className="text-blue-400 shrink-0" />}
                              options={availableModels.map((m) => ({
                                value: m.id,
                                label: (
                                  <div className="flex items-center justify-between gap-3 w-full">
                                    <span className="truncate">{m.label}</span>
                                    <span className="text-[10px] text-zinc-500 shrink-0">{m.provider}</span>
                                  </div>
                                ),
                              }))}
                            />
                          </div>
                        )}

                        {step.type === "llm" && (
                          <Select
                            value={step.effort || "medium"}
                            onChange={(e) => handleUpdateStep(step.id, { effort: e.target.value })}
                            containerClassName="w-auto min-w-[105px]"
                            triggerClassName="h-7 !py-1 !px-2.5 text-xs rounded-lg bg-zinc-800/90 border-zinc-700/80 hover:bg-zinc-700 text-zinc-200 capitalize"
                            menuClassName="bg-zinc-900 border-zinc-700 text-zinc-200 z-50"
                            leadingIcon={
                              <div className="flex items-end gap-0.5 h-3">
                                <span className={cn("w-0.5 rounded-full bg-zinc-300", step.effort === "high" || step.effort === "medium" || !step.effort ? "h-2" : "h-1.5")} />
                                <span className={cn("w-0.5 rounded-full", step.effort === "high" || step.effort === "medium" || !step.effort ? "h-2.5 bg-zinc-300" : "h-1 bg-zinc-600")} />
                                <span className={cn("w-0.5 rounded-full", step.effort === "high" ? "h-3 bg-zinc-300" : "h-1 bg-zinc-600")} />
                              </div>
                            }
                            options={[
                              { value: "low", label: "Low" },
                              { value: "medium", label: "Medium" },
                              { value: "high", label: "High" },
                            ]}
                          />
                        )}
                      </div>

                      {/* Optional System Prompt Expander */}
                      {step.type === "llm" && (
                        <div className="flex flex-col gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => {
                              setExpandedSystemPromptStepIds((prev) => {
                                const next = new Set(prev);
                                if (next.has(step.id)) next.delete(step.id);
                                else next.add(step.id);
                                return next;
                              });
                            }}
                            className="text-left text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors flex items-center gap-1"
                          >
                            <ChevronRight
                              size={11}
                              className={cn(
                                "transition-transform",
                                expandedSystemPromptStepIds.has(step.id) ? "rotate-90" : ""
                              )}
                            />
                            <span>System prompt (optional)</span>
                          </button>
                          {expandedSystemPromptStepIds.has(step.id) && (
                            <textarea
                              rows={2}
                              value={step.system_prompt || ""}
                              placeholder="Enter custom persona or system instructions..."
                              onChange={(e) => handleUpdateStep(step.id, { system_prompt: e.target.value })}
                              className="w-full bg-zinc-950/80 border border-zinc-800 rounded-lg p-2 text-xs text-zinc-300 placeholder-zinc-600 focus:outline-none resize-none font-sans"
                            />
                          )}
                        </div>
                      )}

                      {/* Benchmark-matching Result Box */}
                      {outputText && (
                        <div className="rounded-xl bg-zinc-950/90 border border-zinc-800/90 p-2.5 flex flex-col gap-1.5 shrink-0 shadow-inner">
                          <div className="flex items-center justify-between text-[11px] font-medium text-zinc-300">
                            <span className="flex items-center gap-1.5 font-semibold text-zinc-200">
                              <CheckCircle2 size={12} className="text-emerald-400" />
                              <span>Result</span>
                            </span>

                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(outputText);
                                  setCopiedStepId(step.id);
                                  setTimeout(() => setCopiedStepId(null), 2000);
                                } catch {
                                  // fallback
                                }
                              }}
                              className="text-zinc-400 hover:text-white flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded hover:bg-zinc-800 transition-colors"
                              title="Copy result to clipboard"
                            >
                              {copiedStepId === step.id ? (
                                <>
                                  <Check size={11} className="text-emerald-400" />
                                  <span className="text-emerald-400">Copied!</span>
                                </>
                              ) : (
                                <>
                                  <Copy size={11} />
                                  <span>Copy</span>
                                </>
                              )}
                            </button>
                          </div>

                          <div className="text-xs text-zinc-300 bg-zinc-900/80 rounded-lg p-2.5 whitespace-pre-wrap font-sans max-h-44 overflow-y-auto leading-relaxed border border-zinc-800">
                            {outputText}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Inline Full-width "Run" Button */}
                    <button
                      type="button"
                      disabled={isRunningThis}
                      onClick={() => handleRunStep(step.id)}
                      className="w-full py-2 rounded-xl bg-zinc-800/90 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold flex items-center justify-center gap-1.5 transition-all shadow-sm active:scale-98 disabled:opacity-50 shrink-0"
                    >
                      {isRunningThis ? (
                        <span className="w-3 h-3 border-2 border-zinc-300 border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <Play size={11} className="fill-zinc-300" />
                      )}
                      <span>Run</span>
                    </button>
                  </div>
                )}

                {/* Condition Form */}
                {step.type === "condition" && (
                  <div className="flex flex-col gap-2.5 text-xs">
                    <input
                      type="text"
                      value={step.target || ""}
                      placeholder="Context field (e.g. steps.step_1.output)"
                      onChange={(e) => handleUpdateStep(step.id, { target: e.target.value })}
                      className="bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-xs text-zinc-200 font-mono"
                    />
                    <div className="flex items-center gap-2">
                      <Select
                        value={step.operator || "contains"}
                        onChange={(e) =>
                          handleUpdateStep(step.id, {
                            operator: e.target.value as WorkflowStep["operator"],
                          })
                        }
                        containerClassName="w-auto min-w-[130px]"
                        triggerClassName="h-7 !py-1 !px-2.5 text-xs rounded-lg bg-zinc-800/90 border-zinc-700/80 hover:bg-zinc-700 text-zinc-200"
                        menuClassName="bg-zinc-900 border-zinc-700 text-zinc-200 z-50"
                        options={[
                          { value: "contains", label: "contains" },
                          { value: "equals", label: "equals" },
                          { value: "not_equals", label: "not equals" },
                          { value: "matches_regex", label: "matches regex" },
                          { value: "is_empty", label: "is empty" },
                          { value: "is_not_empty", label: "is not empty" },
                        ]}
                      />

                      <input
                        type="text"
                        value={step.value || ""}
                        placeholder="Value to check"
                        onChange={(e) => handleUpdateStep(step.id, { value: e.target.value })}
                        className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-xs text-zinc-200"
                      />
                    </div>
                  </div>
                )}

                {/* Human Approval Form */}
                {step.type === "approval" && (
                  <div className="flex flex-col gap-2.5 text-xs">
                    <textarea
                      rows={2}
                      value={step.prompt || ""}
                      placeholder="Instructions for human reviewer..."
                      onChange={(e) => handleUpdateStep(step.id, { prompt: e.target.value })}
                      className="bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-xs text-zinc-200 resize-none font-sans"
                    />

                    {liveRun?.status === "waiting_approval" && (
                      <div className="rounded-xl bg-amber-950/20 border border-amber-600/40 p-2.5 flex flex-col gap-2">
                        <span className="text-[11px] font-semibold text-amber-300">
                          Waiting for your approval:
                        </span>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            disabled={actionBusy}
                            onClick={() => handleResolveApproval("approve")}
                            className="flex-1 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs"
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            disabled={actionBusy}
                            onClick={() => handleResolveApproval("reject")}
                            className="flex-1 py-1 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-semibold text-xs"
                          >
                            Reject
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Sticky Note Form */}
                {step.type === "note" && (
                  <div className="flex-1 min-h-0 flex flex-col gap-2">
                    <div className="flex items-center justify-between text-xs pb-1.5 border-b border-white/10 shrink-0">
                      <span className="font-semibold text-xs opacity-75 flex items-center gap-1.5">
                        <StickyNote size={13} />
                        <span>Sticky Note</span>
                      </span>
                      <div className="flex items-center gap-1.5">
                        {(["amber", "neutral", "emerald", "rose", "blue"] as const).map((c) => (
                          <button
                            key={c}
                            type="button"
                            onClick={() => handleUpdateStep(step.id, { color: c })}
                            className={cn(
                              "w-3 h-3 rounded-full transition-transform hover:scale-125",
                              c === "amber" && "bg-amber-400",
                              c === "neutral" && "bg-zinc-200",
                              c === "emerald" && "bg-emerald-400",
                              c === "rose" && "bg-rose-400",
                              c === "blue" && "bg-blue-400",
                              (step.color || "amber") === c ? "ring-2 ring-white scale-110" : "opacity-40"
                            )}
                            title={`Color ${c}`}
                          />
                        ))}
                      </div>
                    </div>
                    <textarea
                      value={step.prompt || ""}
                      placeholder="Type thoughts, instructions or documentation..."
                      onChange={(e) => handleUpdateStep(step.id, { prompt: e.target.value })}
                      className="flex-1 min-h-[70px] w-full bg-transparent border-none text-xs leading-relaxed focus:outline-none resize-none font-sans"
                    />
                  </div>
                )}

                {/* End Step Form */}
                {step.type === "end" && (
                  <div className="flex flex-col gap-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-zinc-400 text-[11px]">Completion status</span>
                      <Select
                        value={step.status || "completed"}
                        onChange={(e) =>
                          handleUpdateStep(step.id, {
                            status: e.target.value as "completed" | "failed",
                          })
                        }
                        containerClassName="w-auto min-w-[125px]"
                        triggerClassName="h-7 !py-1 !px-2.5 text-xs rounded-lg bg-zinc-800/90 border-zinc-700/80 hover:bg-zinc-700 text-zinc-200 capitalize"
                        menuClassName="bg-zinc-900 border-zinc-700 text-zinc-200 z-50"
                        leadingIcon={
                          <span
                            className={cn(
                              "w-2 h-2 rounded-full",
                              step.status === "failed" ? "bg-rose-400" : "bg-emerald-400"
                            )}
                          />
                        }
                        options={[
                          {
                            value: "completed",
                            label: (
                              <div className="flex items-center gap-2">
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                                <span>Completed</span>
                              </div>
                            ),
                          },
                          {
                            value: "failed",
                            label: (
                              <div className="flex items-center gap-2">
                                <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />
                                <span>Failed</span>
                              </div>
                            ),
                          },
                        ]}
                      />
                    </div>
                    <input
                      type="text"
                      value={step.message || ""}
                      placeholder="Workflow completion message..."
                      onChange={(e) => handleUpdateStep(step.id, { message: e.target.value })}
                      className="bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none"
                    />
                  </div>
                )}

                {/* Right Output Ports */}
                {step.type === "condition" ? (
                  <>
                    {(() => {
                      const isTrueActive =
                        (draggingWire?.fromDirection !== "input" &&
                          draggingWire?.fromStepId === step.id &&
                          draggingWire?.fromPort === "true") ||
                        (draggingWire?.fromDirection === "input" &&
                          draggingWire?.snappedTargetId === step.id &&
                          draggingWire?.snappedOutputPort === "true");
                      const isTrueInvalid =
                        isTrueActive &&
                        draggingWire?.snappedTargetId &&
                        draggingWire?.validationResult &&
                        !draggingWire.validationResult.valid;
                      const isTrueValid =
                        isTrueActive &&
                        draggingWire?.snappedTargetId &&
                        (!draggingWire?.validationResult || draggingWire.validationResult.valid);

                      return (
                        <div
                          onPointerDown={(e) =>
                            handlePortPointerDown(e, step.id, "true", pos.x + nodeW, pos.y + 46)
                          }
                          style={{ top: "46px" }}
                          className={cn(
                            "absolute -right-[11px] -translate-y-1/2 w-[22px] h-[22px] rounded-full bg-emerald-950 border border-emerald-500/90 text-emerald-300 hover:bg-emerald-900 hover:scale-115 hover:border-emerald-300 cursor-crosshair flex items-center justify-center z-20 shadow-md transition-all select-none",
                            isTrueInvalid
                              ? "border-red-400 bg-red-600 text-white scale-125 ring-4 ring-red-500/40 shadow-lg"
                              : isTrueValid
                              ? "scale-125 ring-4 ring-emerald-500/40 shadow-lg border-emerald-300"
                              : isTrueActive
                              ? "border-white bg-emerald-900 text-white scale-115"
                              : ""
                          )}
                          title="True branch port"
                        >
                          <Check size={11} strokeWidth={2.5} />
                          {isTrueActive && (
                            <div
                              className={cn(
                                "absolute left-[calc(100%+8px)] top-1/2 -translate-y-1/2 px-2 py-0.5 rounded-md bg-[#18181b] border text-[11px] font-medium whitespace-nowrap shadow-md pointer-events-none select-none z-30 transition-all",
                                isTrueInvalid ? "border-red-500/80 text-red-300" : "border-zinc-700 text-zinc-100"
                              )}
                            >
                              True
                            </div>
                          )}
                        </div>
                      );
                    })()}
                    {(() => {
                      const isFalseActive =
                        (draggingWire?.fromDirection !== "input" &&
                          draggingWire?.fromStepId === step.id &&
                          draggingWire?.fromPort === "false") ||
                        (draggingWire?.fromDirection === "input" &&
                          draggingWire?.snappedTargetId === step.id &&
                          draggingWire?.snappedOutputPort === "false");
                      const isFalseInvalid =
                        isFalseActive &&
                        draggingWire?.snappedTargetId &&
                        draggingWire?.validationResult &&
                        !draggingWire.validationResult.valid;
                      const isFalseValid =
                        isFalseActive &&
                        draggingWire?.snappedTargetId &&
                        (!draggingWire?.validationResult || draggingWire.validationResult.valid);

                      return (
                        <div
                          onPointerDown={(e) =>
                            handlePortPointerDown(e, step.id, "false", pos.x + nodeW, pos.y + 74)
                          }
                          style={{ top: "74px" }}
                          className={cn(
                            "absolute -right-[11px] -translate-y-1/2 w-[22px] h-[22px] rounded-full bg-amber-950 border border-amber-500/90 text-amber-300 hover:bg-amber-900 hover:scale-115 hover:border-amber-300 cursor-crosshair flex items-center justify-center z-20 shadow-md transition-all select-none",
                            isFalseInvalid
                              ? "border-red-400 bg-red-600 text-white scale-125 ring-4 ring-red-500/40 shadow-lg"
                              : isFalseValid
                              ? "scale-125 ring-4 ring-amber-500/40 shadow-lg border-amber-300"
                              : isFalseActive
                              ? "border-white bg-amber-900 text-white scale-115"
                              : ""
                          )}
                          title="False branch port"
                        >
                          <X size={11} strokeWidth={2.5} />
                          {isFalseActive && (
                            <div
                              className={cn(
                                "absolute left-[calc(100%+8px)] top-1/2 -translate-y-1/2 px-2 py-0.5 rounded-md bg-[#18181b] border text-[11px] font-medium whitespace-nowrap shadow-md pointer-events-none select-none z-30 transition-all",
                                isFalseInvalid ? "border-red-500/80 text-red-300" : "border-zinc-700 text-zinc-100"
                              )}
                            >
                              False
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </>
                ) : step.type === "approval" ? (
                  <>
                    {(() => {
                      const isApproveActive =
                        (draggingWire?.fromDirection !== "input" &&
                          draggingWire?.fromStepId === step.id &&
                          draggingWire?.fromPort === "approve") ||
                        (draggingWire?.fromDirection === "input" &&
                          draggingWire?.snappedTargetId === step.id &&
                          draggingWire?.snappedOutputPort === "approve");
                      const isApproveInvalid =
                        isApproveActive &&
                        draggingWire?.snappedTargetId &&
                        draggingWire?.validationResult &&
                        !draggingWire.validationResult.valid;
                      const isApproveValid =
                        isApproveActive &&
                        draggingWire?.snappedTargetId &&
                        (!draggingWire?.validationResult || draggingWire.validationResult.valid);

                      return (
                        <div
                          onPointerDown={(e) =>
                            handlePortPointerDown(e, step.id, "approve", pos.x + nodeW, pos.y + 46)
                          }
                          style={{ top: "46px" }}
                          className={cn(
                            "absolute -right-[11px] -translate-y-1/2 w-[22px] h-[22px] rounded-full bg-emerald-950 border border-emerald-500/90 text-emerald-300 hover:bg-emerald-900 hover:scale-115 hover:border-emerald-300 cursor-crosshair flex items-center justify-center z-20 shadow-md transition-all select-none",
                            isApproveInvalid
                              ? "border-red-400 bg-red-600 text-white scale-125 ring-4 ring-red-500/40 shadow-lg"
                              : isApproveValid
                              ? "scale-125 ring-4 ring-emerald-500/40 shadow-lg border-emerald-300"
                              : isApproveActive
                              ? "border-white bg-emerald-900 text-white scale-115"
                              : ""
                          )}
                          title="Approve branch port"
                        >
                          <Check size={11} strokeWidth={2.5} />
                          {isApproveActive && (
                            <div
                              className={cn(
                                "absolute left-[calc(100%+8px)] top-1/2 -translate-y-1/2 px-2 py-0.5 rounded-md bg-[#18181b] border text-[11px] font-medium whitespace-nowrap shadow-md pointer-events-none select-none z-30 transition-all",
                                isApproveInvalid ? "border-red-500/80 text-red-300" : "border-zinc-700 text-zinc-100"
                              )}
                            >
                              Approve
                            </div>
                          )}
                        </div>
                      );
                    })()}
                    {(() => {
                      const isRejectActive =
                        (draggingWire?.fromDirection !== "input" &&
                          draggingWire?.fromStepId === step.id &&
                          draggingWire?.fromPort === "reject") ||
                        (draggingWire?.fromDirection === "input" &&
                          draggingWire?.snappedTargetId === step.id &&
                          draggingWire?.snappedOutputPort === "reject");
                      const isRejectInvalid =
                        isRejectActive &&
                        draggingWire?.snappedTargetId &&
                        draggingWire?.validationResult &&
                        !draggingWire.validationResult.valid;
                      const isRejectValid =
                        isRejectActive &&
                        draggingWire?.snappedTargetId &&
                        (!draggingWire?.validationResult || draggingWire.validationResult.valid);

                      return (
                        <div
                          onPointerDown={(e) =>
                            handlePortPointerDown(e, step.id, "reject", pos.x + nodeW, pos.y + 74)
                          }
                          style={{ top: "74px" }}
                          className={cn(
                            "absolute -right-[11px] -translate-y-1/2 w-[22px] h-[22px] rounded-full bg-rose-950 border border-rose-500/90 text-rose-300 hover:bg-rose-900 hover:scale-115 hover:border-rose-300 cursor-crosshair flex items-center justify-center z-20 shadow-md transition-all select-none",
                            isRejectInvalid
                              ? "border-red-400 bg-red-600 text-white scale-125 ring-4 ring-red-500/40 shadow-lg"
                              : isRejectValid
                              ? "scale-125 ring-4 ring-rose-500/40 shadow-lg border-rose-300"
                              : isRejectActive
                              ? "border-white bg-rose-900 text-white scale-115"
                              : ""
                          )}
                          title="Reject branch port"
                        >
                          <X size={11} strokeWidth={2.5} />
                          {isRejectActive && (
                            <div
                              className={cn(
                                "absolute left-[calc(100%+8px)] top-1/2 -translate-y-1/2 px-2 py-0.5 rounded-md bg-[#18181b] border text-[11px] font-medium whitespace-nowrap shadow-md pointer-events-none select-none z-30 transition-all",
                                isRejectInvalid ? "border-red-500/80 text-red-300" : "border-zinc-700 text-zinc-100"
                              )}
                            >
                              Reject
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </>
                ) : step.type !== "end" && step.type !== "note" ? (
                  (() => {
                    const isOutActive =
                      (draggingWire?.fromDirection !== "input" &&
                        draggingWire?.fromStepId === step.id &&
                        draggingWire?.fromPort === "out") ||
                      (draggingWire?.fromDirection === "input" &&
                        draggingWire?.snappedTargetId === step.id &&
                        draggingWire?.snappedOutputPort === "out");
                    const isOutInvalid =
                      isOutActive &&
                      draggingWire?.snappedTargetId &&
                      draggingWire?.validationResult &&
                      !draggingWire.validationResult.valid;
                    const isOutValid =
                      isOutActive &&
                      draggingWire?.snappedTargetId &&
                      (!draggingWire?.validationResult || draggingWire.validationResult.valid);

                    return (
                      <div
                        onPointerDown={(e) =>
                          handlePortPointerDown(
                            e,
                            step.id,
                            "out",
                            pos.x + nodeW,
                            pos.y + (step.type === "trigger" ? getTriggerPortOffsetY(step) : 48)
                          )
                        }
                        style={{
                          top: `${step.type === "trigger" ? getTriggerPortOffsetY(step) : 48}px`,
                        }}
                        className={cn(
                          "absolute -right-[11px] -translate-y-1/2 w-[22px] h-[22px] rounded-full bg-[#18181b] border transition-all cursor-crosshair flex items-center justify-center z-20 text-[10px] font-mono font-bold select-none shadow-md",
                          isOutInvalid
                            ? "border-red-400 bg-red-600 text-white scale-125 ring-4 ring-red-500/40 shadow-lg"
                            : isOutValid
                            ? "border-emerald-400 bg-emerald-950 text-emerald-300 scale-125 ring-4 ring-emerald-500/40 shadow-lg"
                            : isOutActive
                            ? "border-white bg-zinc-800 text-white scale-115"
                            : "border-zinc-600/90 text-zinc-400 hover:border-white hover:text-white hover:scale-115 hover:bg-zinc-800"
                        )}
                        title={step.type === "trigger" ? "Trigger output (drag to connect)" : "Output text (drag to connect)"}
                      >
                        T
                        {isOutActive && (
                          <div
                            className={cn(
                              "absolute left-[calc(100%+8px)] top-1/2 -translate-y-1/2 px-2 py-0.5 rounded-md bg-[#18181b] border text-[11px] font-medium whitespace-nowrap shadow-md pointer-events-none select-none z-30 transition-all",
                              isOutInvalid ? "border-red-500/80 text-red-300" : "border-zinc-700 text-zinc-100"
                            )}
                          >
                            Text
                          </div>
                        )}
                      </div>
                    );
                  })()
                ) : null}
              </div>
            );
          })}
        </div>

        {/* Bottom Floating Dock Toolbar */}
        <div className="ui-dock fixed bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-[#16171d]/95 border border-zinc-700/60 shadow-2xl backdrop-blur-xl px-3 py-2 rounded-2xl z-40">
          <div className="flex items-center gap-1 pr-2 border-r border-zinc-800 text-xs">
            <button
              type="button"
              onClick={() => handleZoom(-0.1)}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
              title="Zoom out"
            >
              <ZoomOut size={15} />
            </button>
            <span className="w-12 text-center font-mono font-medium text-zinc-300">
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              onClick={() => handleZoom(0.1)}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
              title="Zoom in"
            >
              <ZoomIn size={15} />
            </button>
            <button
              type="button"
              onClick={handleFitToScreen}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
              title="Fit all nodes to view"
            >
              <Maximize2 size={15} />
            </button>
          </div>

          <div className="flex items-center gap-1 pr-2 border-r border-zinc-800">
            <button
              type="button"
              onClick={() => setTool("select")}
              className={cn(
                "p-2 rounded-xl transition-colors",
                tool === "select" ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-white hover:bg-zinc-800/60"
              )}
              title="Select tool"
            >
              <MousePointer2 size={16} />
            </button>
            <button
              type="button"
              onClick={() => setTool("pan")}
              className={cn(
                "p-2 rounded-xl transition-colors",
                tool === "pan" ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-white hover:bg-zinc-800/60"
              )}
              title="Hand / Pan tool"
            >
              <Hand size={16} />
            </button>
            <button
              type="button"
              onClick={() => setTool(tool === "draw" ? "select" : "draw")}
              className={cn(
                "p-2 rounded-xl transition-colors",
                tool === "draw" ? "bg-purple-900 text-purple-200" : "text-zinc-400 hover:text-white hover:bg-zinc-800/60"
              )}
              title="Pencil / Draw annotations"
            >
              <PenTool size={16} />
            </button>
            <button
              type="button"
              onClick={() => handleAddNode("note", "amber")}
              className="p-2 rounded-xl text-zinc-400 hover:text-white hover:bg-zinc-800/60 transition-colors"
              title="Orange Sticky Note"
            >
              <div className="w-4 h-4 rounded-md bg-amber-500 shadow-sm" />
            </button>
            <button
              type="button"
              onClick={() => handleAddNode("note", "neutral")}
              className="p-2 rounded-xl text-zinc-400 hover:text-white hover:bg-zinc-800/60 transition-colors"
              title="White Sticky Note"
            >
              <div className="w-4 h-4 rounded-md bg-zinc-200 shadow-sm" />
            </button>
            <button
              type="button"
              onClick={() => handleAddNode("note", "neutral")}
              className="p-2 rounded-xl text-zinc-400 hover:text-white hover:bg-zinc-800/60 transition-colors"
              title="Text Tool"
            >
              <Type size={16} />
            </button>
            <button
              type="button"
              onClick={() => {
                setShowAddMenu(!showAddMenu);
                setNodeSearch("");
              }}
              className={cn(
                "p-2 rounded-xl transition-colors",
                showAddMenu ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-white hover:bg-zinc-800/60"
              )}
              title="Search and add nodes"
            >
              <Search size={16} />
            </button>
          </div>

          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setShowAddMenu(!showAddMenu);
                setNodeSearch("");
              }}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-white text-zinc-950 font-semibold text-xs hover:bg-zinc-100 shadow-md transition-all active:scale-95"
            >
              <Plus size={15} />
              <span>Add node</span>
            </button>

            {showAddMenu && (
              <div className="absolute bottom-full mb-3 left-1/2 -translate-x-1/2 w-64 rounded-2xl border border-zinc-700/80 bg-[#14151a] shadow-2xl backdrop-blur-xl p-2 z-50 flex flex-col gap-1">
                <div className="px-2 py-1 border-b border-zinc-800 flex items-center gap-1.5 mb-1">
                  <Search size={13} className="text-zinc-500" />
                  <input
                    type="text"
                    autoFocus
                    placeholder="Search node types..."
                    value={nodeSearch}
                    onChange={(e) => setNodeSearch(e.target.value)}
                    className="bg-transparent border-none text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none w-full"
                  />
                </div>

                {(!nodeSearch || "trigger node".includes(nodeSearch.toLowerCase())) && (
                  <button
                    type="button"
                    onClick={() => { handleAddNode("trigger"); setShowAddMenu(false); }}
                    className="w-full px-2.5 py-1.5 rounded-xl text-xs font-medium text-zinc-200 hover:bg-zinc-800 flex items-center gap-2.5 text-left"
                  >
                    <Zap size={15} className="text-amber-400 fill-amber-400" />
                    <span>Trigger Node</span>
                  </button>
                )}
                {(!nodeSearch || "llm step".includes(nodeSearch.toLowerCase())) && (
                  <button
                    type="button"
                    onClick={() => { handleAddNode("llm"); setShowAddMenu(false); }}
                    className="w-full px-2.5 py-1.5 rounded-xl text-xs font-medium text-zinc-200 hover:bg-zinc-800 flex items-center gap-2.5 text-left"
                  >
                    <Sparkles size={15} className="text-purple-400" />
                    <span>LLM Step</span>
                  </button>
                )}
                {(!nodeSearch || "agent step".includes(nodeSearch.toLowerCase())) && (
                  <button
                    type="button"
                    onClick={() => { handleAddNode("agent"); setShowAddMenu(false); }}
                    className="w-full px-2.5 py-1.5 rounded-xl text-xs font-medium text-zinc-200 hover:bg-zinc-800 flex items-center gap-2.5 text-left"
                  >
                    <Bot size={15} className="text-blue-400" />
                    <span>Agent Step</span>
                  </button>
                )}
                {(!nodeSearch || "condition branch".includes(nodeSearch.toLowerCase())) && (
                  <button
                    type="button"
                    onClick={() => { handleAddNode("condition"); setShowAddMenu(false); }}
                    className="w-full px-2.5 py-1.5 rounded-xl text-xs font-medium text-zinc-200 hover:bg-zinc-800 flex items-center gap-2.5 text-left"
                  >
                    <GitBranch size={15} className="text-amber-400" />
                    <span>Condition Branch</span>
                  </button>
                )}
                {(!nodeSearch || "human approval".includes(nodeSearch.toLowerCase())) && (
                  <button
                    type="button"
                    onClick={() => { handleAddNode("approval"); setShowAddMenu(false); }}
                    className="w-full px-2.5 py-1.5 rounded-xl text-xs font-medium text-zinc-200 hover:bg-zinc-800 flex items-center gap-2.5 text-left"
                  >
                    <ShieldAlert size={15} className="text-rose-400" />
                    <span>Human Approval</span>
                  </button>
                )}
                {(!nodeSearch || "orange sticky note".includes(nodeSearch.toLowerCase())) && (
                  <button
                    type="button"
                    onClick={() => { handleAddNode("note", "amber"); setShowAddMenu(false); }}
                    className="w-full px-2.5 py-1.5 rounded-xl text-xs font-medium text-zinc-200 hover:bg-zinc-800 flex items-center gap-2.5 text-left"
                  >
                    <div className="w-3.5 h-3.5 rounded bg-amber-500" />
                    <span>Orange Sticky Note</span>
                  </button>
                )}
                {(!nodeSearch || "white sticky note".includes(nodeSearch.toLowerCase())) && (
                  <button
                    type="button"
                    onClick={() => { handleAddNode("note", "neutral"); setShowAddMenu(false); }}
                    className="w-full px-2.5 py-1.5 rounded-xl text-xs font-medium text-zinc-200 hover:bg-zinc-800 flex items-center gap-2.5 text-left"
                  >
                    <div className="w-3.5 h-3.5 rounded bg-zinc-200" />
                    <span>White Sticky Note</span>
                  </button>
                )}
                {(!nodeSearch || "end completion".includes(nodeSearch.toLowerCase())) && (
                  <button
                    type="button"
                    onClick={() => { handleAddNode("end"); setShowAddMenu(false); }}
                    className="w-full px-2.5 py-1.5 rounded-xl text-xs font-medium text-zinc-200 hover:bg-zinc-800 flex items-center gap-2.5 text-left"
                  >
                    <CheckCircle2 size={15} className="text-emerald-400" />
                    <span>End</span>
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Slide-over Run History Drawer */}
      {historyDrawerOpen && (
        <aside className="fixed top-14 right-0 bottom-0 w-[420px] max-w-full bg-[#101116]/98 border-l border-zinc-800 shadow-2xl z-50 flex flex-col backdrop-blur-xl animate-in slide-in-from-right duration-200">
          <div className="h-13 border-b border-zinc-800 px-4 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2 font-semibold text-sm text-zinc-100">
              <History size={16} className="text-zinc-400" />
              <span>Workflow Runs ({runs.length})</span>
            </div>
            <button
              type="button"
              onClick={() => setHistoryDrawerOpen(false)}
              className="p-1.5 text-zinc-400 hover:text-white rounded-lg hover:bg-zinc-800"
            >
              <X size={16} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
            {runs.length === 0 ? (
              <div className="py-12 text-center text-xs text-zinc-500">
                No runs recorded yet. Click &quot;Run workflow&quot; to test!
              </div>
            ) : (
              runs.map((r) => {
                const isSelected = activeRun?.id === r.id;
                return (
                  <div
                    key={r.id}
                    onClick={() => setSelectedRunId(r.id)}
                    className={cn(
                      "rounded-xl border p-3.5 cursor-pointer transition-all flex flex-col gap-2",
                      isSelected
                        ? "border-accent bg-zinc-900/90 shadow-md ring-1 ring-accent/30"
                        : "border-zinc-800/80 bg-zinc-900/40 hover:bg-zinc-900/80 hover:border-zinc-700"
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {r.status === "completed" && <CheckCircle2 size={14} className="text-emerald-400" />}
                        {r.status === "running" && (
                          <span className="w-3.5 h-3.5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                        )}
                        {r.status === "waiting_approval" && (
                          <ShieldAlert size={14} className="text-amber-400 animate-pulse" />
                        )}
                        {(r.status === "failed" || r.status === "cancelled") && (
                          <AlertTriangle size={14} className="text-rose-400" />
                        )}

                        <span className="text-xs font-semibold text-zinc-200">Run #{r.id}</span>
                      </div>

                      <span
                        className={cn(
                          "px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider",
                          r.status === "completed"
                            ? "bg-emerald-950/60 text-emerald-400 border border-emerald-800/60"
                            : r.status === "running"
                            ? "bg-blue-950/60 text-blue-400 border border-blue-800/60"
                            : r.status === "waiting_approval"
                            ? "bg-amber-950/60 text-amber-400 border border-amber-800/60"
                            : "bg-rose-950/60 text-rose-400 border border-rose-800/60"
                        )}
                      >
                        {r.status}
                      </span>
                    </div>

                    <div className="text-[11px] text-zinc-500 flex items-center justify-between">
                      <span>Trigger: {r.trigger}</span>
                      <span>{new Date(r.started_at || "").toLocaleTimeString()}</span>
                    </div>

                    {/* Step Execution Timeline */}
                    {isSelected && (
                      <div className="mt-2 pt-3 border-t border-zinc-800 flex flex-col gap-2.5">
                        <span className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">
                          Step Execution Output
                        </span>

                        {Object.values(r.step_states || {}).length === 0 ? (
                          <span className="text-xs text-zinc-500 italic">No step outputs recorded.</span>
                        ) : (
                          Object.values(r.step_states || {}).map((st) => (
                            <div
                              key={st.id}
                              className="rounded-lg bg-zinc-950 border border-zinc-800/90 p-2.5 flex flex-col gap-1.5"
                            >
                              <div className="flex items-center justify-between text-xs font-medium">
                                <span className="text-zinc-200">{st.name}</span>
                                <span className="text-[10px] text-zinc-500 uppercase">{st.status}</span>
                              </div>

                              {st.output ? (
                                <div className="text-xs text-zinc-300 bg-zinc-900/80 rounded-md p-2 whitespace-pre-wrap font-sans border border-zinc-800/60 leading-relaxed max-h-48 overflow-y-auto">
                                  {st.output}
                                </div>
                              ) : st.result !== undefined ? (
                                <div className="text-xs text-zinc-400">
                                  Result: <span className="font-semibold text-zinc-200">{String(st.result)}</span>
                                </div>
                              ) : null}
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </aside>
      )}
    </div>
  );
}

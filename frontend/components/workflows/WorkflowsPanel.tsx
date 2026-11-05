"use client";

import { useCallback, useEffect, useState } from "react";
import {
  api,
  type Agent,
  type Engine,
  type Workflow,
  type WorkflowRun,
  type WorkflowStep,
} from "@/lib/api";
import { WorkflowCanvas } from "./WorkflowCanvas";

interface WorkflowsPanelProps {
  agents: Agent[];
  engines?: Engine[];
  onClose: () => void;
}

const DEFAULT_WORKFLOW_STEPS: WorkflowStep[] = [
  {
    id: "trigger_1",
    name: "Trigger",
    type: "trigger",
    trigger_type: "schedule",
    schedule_kind: "daily",
    schedule_days: "every_day",
    schedule_time: "09:00",
    next_step_id: "step_1",
    x: 60,
    y: 120,
  },
  {
    id: "step_1",
    name: "Initial LLM Analysis",
    type: "llm",
    prompt: "Analyze the user request and identify action items: {{input.message}}",
    model: "gemini-2.0-flash",
    effort: "medium",
    next_step_id: "step_2",
    x: 360,
    y: 120,
  },
  {
    id: "step_2",
    name: "Agent Action",
    type: "agent",
    agent_id: 1,
    prompt: "Take action based on analysis: {{steps.step_1.output}}",
    approval_mode: "ask",
    next_step_id: "step_3",
    x: 740,
    y: 120,
  },
  {
    id: "step_3",
    name: "Priority Check",
    type: "condition",
    target: "steps.step_1.output",
    operator: "contains",
    value: "urgent",
    if_true: "step_4",
    if_false: "step_5",
    x: 1120,
    y: 120,
  },
  {
    id: "step_4",
    name: "Human Escalation Approval",
    type: "approval",
    prompt: "High priority item detected. Please confirm escalation action.",
    timeout_minutes: 60,
    on_approve: "step_5",
    on_reject: null,
    x: 1500,
    y: 60,
  },
  {
    id: "step_5",
    name: "Completed",
    type: "end",
    status: "completed",
    message: "Workflow finished successfully.",
    x: 1500,
    y: 220,
  },
];

export function WorkflowsPanel({ agents, engines = [], onClose }: WorkflowsPanelProps) {
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<number | null>(null);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [wfs, rList] = await Promise.all([
        api.listWorkflows(),
        api.listAllWorkflowRuns(50),
      ]);

      if (wfs.length === 0) {
        // Automatically create initial starter workflow if none exist
        const initial = await api.createWorkflow({
          name: "Customer Support Workflow",
          description: "Multi-step automated triage with conditional escalation",
          trigger_type: "manual",
          steps: DEFAULT_WORKFLOW_STEPS,
        });
        setWorkflows([initial]);
        setSelectedWorkflowId(initial.id);
      } else {
        setWorkflows(wfs);
        setSelectedWorkflowId((prev) => (prev !== null ? prev : wfs[0].id));
      }
      setRuns(rList);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      await loadData();
    })();
    const interval = setInterval(() => {
      void api.listAllWorkflowRuns(50).then((fresh) => {
        if (active) setRuns(fresh);
      }).catch(() => {});
    }, 4000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [loadData]);

  const activeWorkflow = workflows?.find((w) => w.id === selectedWorkflowId) || workflows?.[0];

  const handleCreateWorkflow = async () => {
    try {
      const newWf = await api.createWorkflow({
        name: `Untitled workflow`,
        description: "New visual automation workflow",
        trigger_type: "manual",
        steps: [
          {
            id: "trigger_1",
            name: "Trigger",
            type: "trigger",
            trigger_type: "schedule",
            schedule_kind: "daily",
            schedule_days: "every_day",
            schedule_time: "09:00",
            next_step_id: "step_1",
            x: 60,
            y: 140,
          },
          {
            id: "step_1",
            name: "LLM Step",
            type: "llm",
            prompt: "Type your prompt here...",
            model: "gemini-2.0-flash",
            effort: "medium",
            next_step_id: null,
            x: 440,
            y: 140,
          },
        ],
      });
      setWorkflows((prev) => (prev ? [newWf, ...prev] : [newWf]));
      setSelectedWorkflowId(newWf.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleUpdateWorkflow = async (partial: Partial<Workflow>) => {
    if (!activeWorkflow) return;
    try {
      const updated = await api.updateWorkflow(activeWorkflow.id, partial);
      setWorkflows((prev) =>
        prev ? prev.map((w) => (w.id === updated.id ? updated : w)) : [updated]
      );
    } catch (err) {
      console.error("Failed to update workflow:", err);
    }
  };

  const handleRunWorkflow = async () => {
    if (!activeWorkflow) return;
    try {
      await api.startWorkflowRun(activeWorkflow.id, {
        message: "Interactive manual run from visual canvas",
      });
      const freshRuns = await api.listAllWorkflowRuns(50);
      setRuns(freshRuns);
    } catch (err) {
      alert(`Run failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  if (loading && !workflows) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#0b0c0e] text-white">
        <div className="flex flex-col items-center gap-3">
          <span className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          <span className="text-xs text-zinc-400">Loading visual workflow canvas...</span>
        </div>
      </div>
    );
  }

  if (error && !workflows) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#0b0c0e] text-white p-4">
        <div className="rounded-2xl border border-rose-800 bg-zinc-900 p-6 max-w-md flex flex-col gap-4 text-center">
          <span className="text-rose-400 font-semibold text-sm">Failed to load workflows</span>
          <p className="text-xs text-zinc-400">{error}</p>
          <button
            type="button"
            onClick={loadData}
            className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-xl text-xs font-semibold"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!activeWorkflow) return null;

  return (
    <WorkflowCanvas
      workflow={activeWorkflow}
      workflows={workflows || []}
      agents={agents}
      engines={engines}
      runs={runs}
      onSelectWorkflow={(id) => setSelectedWorkflowId(id)}
      onCreateWorkflow={handleCreateWorkflow}
      onUpdateWorkflow={handleUpdateWorkflow}
      onRunWorkflow={handleRunWorkflow}
      onClose={onClose}
      onRefreshRuns={loadData}
    />
  );
}
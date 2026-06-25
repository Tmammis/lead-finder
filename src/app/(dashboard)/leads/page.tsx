"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { formatKr } from "@/lib/utils";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { Users, Sparkles, Loader2, X, Download, Target } from "lucide-react";
import { ScoreBadgeCompact } from "@/components/score-badge";
import { getLeadDisplayName } from "@/lib/utils/lead-display";

const STAGE_OPTIONS = [
  { value: "no_answer", label: "No answer" },
  { value: "info_sent_sms", label: "Info sent (SMS)" },
  { value: "info_sent_email", label: "Info sent (email)" },
  { value: "interested", label: "Interested" },
  { value: "not_interested", label: "Not interested" },
  { value: "meeting_booked", label: "Meeting booked" },
] as const;

const stageColors: Record<string, string> = {
  no_answer: "bg-yellow-100 text-yellow-800",
  info_sent_sms: "bg-blue-100 text-blue-800",
  info_sent_email: "bg-blue-100 text-blue-800",
  interested: "bg-green-100 text-green-800",
  not_interested: "bg-red-100 text-red-800",
  meeting_booked: "bg-emerald-100 text-emerald-800",
};

function stageLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return STAGE_OPTIONS.find((s) => s.value === value)?.label || value;
}

interface LeadFieldDefinition {
  id: string;
  label: string;
  type: "text" | "number" | "boolean" | "url";
  description?: string;
}

interface Campaign {
  id: number;
  name: string;
  leadFieldDefinitions?: LeadFieldDefinition[];
}

interface Lead {
  id: number;
  displayName: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  score: number;
  status: string;
  stage: string | null;
  notes: string | null;
  source: string;
  campaignId: number | null;
  rawData?: Record<string, unknown>;
  mappedData?: Record<string, unknown>;
  llmCostUsd?: number;
  apifyCostUsd?: number;
  createdAt: string;
}

interface LeadFilter {
  id: string;
  field: string;
  operator: string;
  value: string | number | boolean;
  label: string;
}

const STATUS_OPTIONS = [
  "new",
  "enriching",
  "qualified",
  "converted",
  "declined",
  "archived",
] as const;

const statusColors: Record<string, string> = {
  new: "bg-blue-100 text-blue-800",
  enriching: "bg-orange-100 text-orange-800",
  qualified: "bg-green-100 text-green-800",
  converted: "bg-emerald-100 text-emerald-800",
  declined: "bg-red-100 text-red-800",
  archived: "bg-gray-100 text-gray-800",
};

function resolveFieldValue(lead: Lead, field: string): unknown {
  const coreVal = lead[field as keyof Lead];
  if (coreVal !== undefined && coreVal !== null) return coreVal;

  if (lead.mappedData?.[field] !== undefined) return lead.mappedData[field];
  if (lead.rawData?.[field] !== undefined) return lead.rawData[field];

  return null;
}

function formatFieldValue(value: unknown, type?: string): string {
  if (value == null) return "—";
  if (type === "boolean") return value === true || value === "true" ? "Yes" : value === false || value === "false" ? "No" : String(value);
  if (type === "number" && typeof value === "number") return value.toLocaleString();
  if (type === "url" && typeof value === "string" && value.startsWith("http")) return value;
  if (typeof value === "object") {
    if (Array.isArray(value)) {
      if (value.length === 0) return "—";
      if (value.every((v) => typeof v !== "object" || v === null)) return value.filter((v) => v != null).join(", ");
      return value.map((item) => {
        if (typeof item !== "object" || item === null) return String(item);
        return Object.values(item as Record<string, unknown>).filter((v) => v != null).map(String).join(": ");
      }).join(", ");
    }
    return Object.entries(value as Record<string, unknown>).filter(([, v]) => v != null).map(([k, v]) => `${k}: ${v}`).join(", ");
  }
  return String(value);
}

function matchesFilter(lead: Lead, filter: LeadFilter): boolean {
  const raw = resolveFieldValue(lead, filter.field);
  const val = raw == null ? "" : raw;

  switch (filter.operator) {
    case "eq":
      return String(val).toLowerCase() === String(filter.value).toLowerCase();
    case "neq":
      return String(val).toLowerCase() !== String(filter.value).toLowerCase();
    case "gt":
      return Number(val) > Number(filter.value);
    case "gte":
      return Number(val) >= Number(filter.value);
    case "lt":
      return Number(val) < Number(filter.value);
    case "lte":
      return Number(val) <= Number(filter.value);
    case "contains":
      return String(val).toLowerCase().includes(String(filter.value).toLowerCase());
    case "not_contains":
      return !String(val).toLowerCase().includes(String(filter.value).toLowerCase());
    case "exists":
      return raw != null && String(raw).trim() !== "";
    case "not_exists":
      return raw == null || String(raw).trim() === "";
    case "starts_with":
      return String(val).toLowerCase().startsWith(String(filter.value).toLowerCase());
    case "ends_with":
      return String(val).toLowerCase().endsWith(String(filter.value).toLowerCase());
    default:
      return true;
  }
}

function applyFilters(leads: Lead[], filters: LeadFilter[]): Lead[] {
  if (filters.length === 0) return leads;
  return leads.filter((lead) => filters.every((f) => matchesFilter(lead, f)));
}

function generateCsv(
  leads: Lead[],
  dynFields: LeadFieldDefinition[]
): string {
  const headers = [
    "ID",
    "Display Name",
    "Stage",
    "Notes",
    ...dynFields.map((f) => f.label),
    "Score",
    "Status",
    "Email",
    "Phone",
    "Website",
  ];

  const escape = (v: string) =>
    v.includes(",") || v.includes('"') || v.includes("\n")
      ? `"${v.replace(/"/g, '""')}"`
      : v;

  const rows = leads.map((lead) => {
    const displayName = lead.displayName || getLeadDisplayName({
      displayName: lead.displayName,
      rawData: lead.rawData ?? undefined,
      mappedData: lead.mappedData ?? undefined,
    });

    const values = [
      String(lead.id),
      displayName,
      stageLabel(lead.stage),
      lead.notes || "",
      ...dynFields.map((f) => formatFieldValue(resolveFieldValue(lead, f.id), f.type)),
      String(lead.score ?? 0),
      lead.status,
      lead.email || "",
      lead.phone || "",
      lead.website || "",
    ];

    return values.map(escape).join(",");
  });

  return [headers.map(escape).join(","), ...rows].join("\n");
}

export default function LeadsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedCampaignId = searchParams.get("campaign")
    ? parseInt(searchParams.get("campaign")!)
    : null;

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selectedCampaign, setSelectedCampaign] = useState<Campaign | null>(null);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState("all");
  const [stageFilter, setStageFilter] = useState("all");
  const [aiQuery, setAiQuery] = useState("");
  const [aiFilters, setAiFilters] = useState<LeadFilter[]>([]);
  const [aiLoading, setAiLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notesDraft, setNotesDraft] = useState<Record<number, string>>({});
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/campaigns")
      .then((r) => r.json())
      .then((data) => setCampaigns(data));
  }, []);

  useEffect(() => {
    if (!selectedCampaignId) {
      setSelectedCampaign(null);
      setLeads([]);
      setTotal(0);
      return;
    }
    fetch(`/api/campaigns/${selectedCampaignId}`)
      .then((r) => r.json())
      .then((data) => {
        setSelectedCampaign({
          id: data.id,
          name: data.name,
          leadFieldDefinitions: data.leadFieldDefinitions || [],
        });
      });
  }, [selectedCampaignId]);

  const loadLeads = useCallback(() => {
    if (!selectedCampaignId) return;
    setLoading(true);
    const params = new URLSearchParams();
    params.set("campaignId", String(selectedCampaignId));
    if (statusFilter !== "all") params.set("status", statusFilter);
    params.set("limit", "500");
    fetch(`/api/leads?${params}`)
      .then((r) => r.json())
      .then((d) => {
        setLeads(d.leads);
        setTotal(d.total);
      })
      .finally(() => setLoading(false));
  }, [selectedCampaignId, statusFilter]);

  useEffect(() => {
    loadLeads();
  }, [loadLeads]);

  const handleCampaignChange = (value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value === "none") {
      params.delete("campaign");
    } else {
      params.set("campaign", value);
    }
    setAiFilters([]);
    setAiQuery("");
    router.push(`/leads?${params.toString()}`);
  };

  const handleAiFilter = async () => {
    if (!aiQuery.trim() || !selectedCampaignId) return;
    setAiLoading(true);
    try {
      const res = await fetch("/api/leads/ai-filter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: aiQuery, campaignId: selectedCampaignId }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Filter generation failed");
      }
      const data = await res.json();
      setAiFilters(data.filters || []);
      if (data.filters?.length === 0) {
        toast.info("No filters could be generated from that query");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to generate filters");
    } finally {
      setAiLoading(false);
    }
  };

  const removeFilter = (filterId: string) => {
    setAiFilters((prev) => prev.filter((f) => f.id !== filterId));
  };

  const clearAllFilters = () => {
    setAiFilters([]);
    setAiQuery("");
  };

  const updateLeadStatus = async (id: number, newStatus: string) => {
    await fetch(`/api/leads/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: newStatus }),
    });
    toast.success(`Lead updated to ${newStatus}`);
    loadLeads();
  };

  const updateLeadStage = async (id: number, newStage: string | null) => {
    setLeads((prev) => prev.map((l) => (l.id === id ? { ...l, stage: newStage } : l)));
    try {
      await fetch(`/api/leads/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage: newStage ?? "" }),
      });
    } catch {
      toast.error("Failed to update stage");
      loadLeads();
    }
  };

  const saveLeadNotes = async (id: number, originalValue: string | null) => {
    const draft = notesDraft[id];
    if (draft === undefined) return;
    if ((draft || "") === (originalValue || "")) {
      setNotesDraft((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      return;
    }
    setLeads((prev) => prev.map((l) => (l.id === id ? { ...l, notes: draft || null } : l)));
    setNotesDraft((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    try {
      await fetch(`/api/leads/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: draft }),
      });
    } catch {
      toast.error("Failed to save notes");
      loadLeads();
    }
  };

  const handleExportCsv = () => {
    const dynFields = selectedCampaign?.leadFieldDefinitions || [];
    const csv = generateCsv(filtered, dynFields);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `leads-${selectedCampaign?.name || "export"}-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${filtered.length} leads to CSV`);
  };

  const filteredByAi = applyFilters(leads, aiFilters);
  const filtered = stageFilter === "all"
    ? filteredByAi
    : stageFilter === "none"
      ? filteredByAi.filter((l) => !l.stage)
      : filteredByAi.filter((l) => l.stage === stageFilter);
  const dynFields = selectedCampaign?.leadFieldDefinitions || [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Leads</h1>
          <p className="text-muted-foreground">
            {selectedCampaign
              ? `${filtered.length} of ${total} leads in ${selectedCampaign.name}`
              : "Select a campaign to view leads"}
          </p>
        </div>
        {selectedCampaign && filtered.length > 0 && (
          <Button variant="outline" size="sm" className="gap-2" onClick={handleExportCsv}>
            <Download className="h-4 w-4" />
            Export CSV
          </Button>
        )}
      </div>

      <div className="flex gap-3">
        <Select
          value={selectedCampaignId ? String(selectedCampaignId) : "none"}
          onValueChange={handleCampaignChange}
        >
          <SelectTrigger className="w-64">
            <div className="flex items-center gap-2 truncate">
              <Target className="h-4 w-4 shrink-0 text-muted-foreground" />
              <SelectValue placeholder="Select campaign" />
            </div>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Select campaign...</SelectItem>
            {campaigns.map((c) => (
              <SelectItem key={c.id} value={String(c.id)}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {selectedCampaign && (
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-44">
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              {STATUS_OPTIONS.map((s) => (
                <SelectItem key={s} value={s}>
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {selectedCampaign && (
          <Select value={stageFilter} onValueChange={setStageFilter}>
            <SelectTrigger className="w-44">
              <SelectValue placeholder="Filter by stage" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Stages</SelectItem>
              <SelectItem value="none">No stage set</SelectItem>
              {STAGE_OPTIONS.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {selectedCampaign && (
        <div className="space-y-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleAiFilter();
            }}
            className="flex gap-2"
          >
            <div className="relative flex-1">
              <Sparkles className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                ref={inputRef}
                value={aiQuery}
                onChange={(e) => setAiQuery(e.target.value)}
                placeholder='Filter with AI, e.g. "leads with more than 1000 followers that are business accounts"'
                className="pl-10"
                disabled={aiLoading}
              />
            </div>
            <Button type="submit" disabled={aiLoading || !aiQuery.trim()} className="gap-2">
              {aiLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              Filter
            </Button>
          </form>

          {aiFilters.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">Active filters:</span>
              {aiFilters.map((f) => (
                <Badge
                  key={f.id}
                  variant="secondary"
                  className="gap-1 pl-2.5 pr-1 py-1"
                >
                  {f.label}
                  <button
                    onClick={() => removeFilter(f.id)}
                    className="ml-0.5 rounded-full p-0.5 hover:bg-muted-foreground/20 transition-colors"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
              <button
                onClick={clearAllFilters}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors underline"
              >
                Clear all
              </button>
            </div>
          )}
        </div>
      )}

      {!selectedCampaign ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Target className="mb-4 h-12 w-12 text-muted-foreground/50" />
            <p className="text-muted-foreground mb-1">Select a campaign to view its leads</p>
            <p className="text-sm text-muted-foreground/70">
              Each campaign has its own dynamic lead fields and data columns
            </p>
          </CardContent>
        </Card>
      ) : loading ? (
        <Card>
          <CardContent className="flex items-center justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Users className="mb-4 h-12 w-12 text-muted-foreground/50" />
            <p className="text-muted-foreground">
              {aiFilters.length > 0
                ? "No leads match the current filters"
                : "No leads found in this campaign"}
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-[180px]">Name</TableHead>
                    <TableHead className="min-w-[140px]">Stage</TableHead>
                    <TableHead className="min-w-[200px]">Notes</TableHead>
                    {dynFields.map((f) => (
                      <TableHead key={f.id} className="min-w-[120px]">
                        {f.label}
                      </TableHead>
                    ))}
                    <TableHead className="min-w-[70px]">Score</TableHead>
                    <TableHead className="min-w-[80px]">Cost</TableHead>
                    <TableHead className="min-w-[100px]">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((lead) => {
                    const displayName = lead.displayName || getLeadDisplayName({
                      displayName: lead.displayName,
                      rawData: lead.rawData ?? undefined,
                      mappedData: lead.mappedData ?? undefined,
                    });

                    return (
                      <TableRow key={lead.id}>
                        <TableCell className="overflow-hidden">
                          <Link
                            href={`/leads/${lead.id}`}
                            className="font-medium hover:underline break-words line-clamp-2"
                          >
                            {displayName}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button className="focus:outline-none">
                                <Badge
                                  className={`${lead.stage ? stageColors[lead.stage] || "" : "bg-gray-100 text-gray-600"} cursor-pointer hover:opacity-80 transition-opacity whitespace-nowrap`}
                                >
                                  {stageLabel(lead.stage)}
                                </Badge>
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                              <DropdownMenuItem
                                onClick={() => updateLeadStage(lead.id, null)}
                                disabled={!lead.stage}
                              >
                                <Badge className="bg-gray-100 text-gray-600 mr-2">—</Badge>
                                Clear
                              </DropdownMenuItem>
                              {STAGE_OPTIONS.map((s) => (
                                <DropdownMenuItem
                                  key={s.value}
                                  onClick={() => updateLeadStage(lead.id, s.value)}
                                  disabled={s.value === lead.stage}
                                >
                                  <Badge className={`${stageColors[s.value] || ""} mr-2`}>
                                    {s.label}
                                  </Badge>
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                        <TableCell>
                          <Input
                            value={notesDraft[lead.id] ?? lead.notes ?? ""}
                            onChange={(e) =>
                              setNotesDraft((prev) => ({ ...prev, [lead.id]: e.target.value }))
                            }
                            onBlur={() => saveLeadNotes(lead.id, lead.notes)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.currentTarget.blur();
                              } else if (e.key === "Escape") {
                                setNotesDraft((prev) => {
                                  const next = { ...prev };
                                  delete next[lead.id];
                                  return next;
                                });
                                e.currentTarget.blur();
                              }
                            }}
                            placeholder="Add notes..."
                            className="h-8 text-sm border-transparent hover:border-input focus:border-input bg-transparent"
                          />
                        </TableCell>
                        {dynFields.map((f) => {
                          const val = formatFieldValue(resolveFieldValue(lead, f.id), f.type);
                          if ((f.type === "url" || val.startsWith("http")) && val !== "—") {
                            return (
                              <TableCell key={f.id} className="text-xs truncate max-w-[180px]">
                                <a
                                  href={val}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-primary hover:underline"
                                >
                                  {val.replace(/^https?:\/\/(www\.)?/, "").split("/")[0]}
                                </a>
                              </TableCell>
                            );
                          }
                          return (
                            <TableCell key={f.id} className="text-sm truncate max-w-[180px]">
                              {val}
                            </TableCell>
                          );
                        })}
                        <TableCell>
                          <ScoreBadgeCompact score={lead.score} />
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground tabular-nums">
                          {((lead.llmCostUsd ?? 0) + (lead.apifyCostUsd ?? 0)) > 0
                            ? formatKr((lead.llmCostUsd ?? 0) + (lead.apifyCostUsd ?? 0), 4)
                            : "—"}
                        </TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button className="focus:outline-none">
                                <Badge
                                  className={`${statusColors[lead.status] || ""} cursor-pointer hover:opacity-80 transition-opacity`}
                                >
                                  {lead.status}
                                </Badge>
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                              {STATUS_OPTIONS.map((s) => (
                                <DropdownMenuItem
                                  key={s}
                                  onClick={() => updateLeadStatus(lead.id, s)}
                                  disabled={s === lead.status}
                                >
                                  <Badge className={`${statusColors[s] || ""} mr-2`}>
                                    {s}
                                  </Badge>
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

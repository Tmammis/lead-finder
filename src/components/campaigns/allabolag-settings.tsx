"use client";

import type { AllabolagConfig } from "@/lib/db/schema";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export const ALLABOLAG_DEFAULTS: AllabolagConfig = {
  enabled: true,
  employeesMin: 5,
  employeesMax: 50,
  revenueMinSek: 5_000_000,
  revenueMaxSek: 50_000_000,
};

// Revenue is stored in SEK but shown to the user in MSEK (millions).
const toM = (sek: number) => sek / 1_000_000;
const fromM = (m: number) => Math.round(m * 1_000_000);

export function AllabolagSettings({
  value,
  onChange,
}: {
  value: AllabolagConfig | null;
  onChange: (next: AllabolagConfig | null) => void;
}) {
  const enabled = value?.enabled ?? false;
  const cfg = value ?? ALLABOLAG_DEFAULTS;

  const setField = (patch: Partial<AllabolagConfig>) =>
    onChange({ ...cfg, ...patch, enabled: true });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-base">
              Enrich with allabolag.se (Sweden)
            </CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Looks up each lead&apos;s employees, latest-year revenue, and owner.
              Leads outside the ranges below (or with no revenue filed) are
              archived. No API cost.
            </p>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={(on) =>
              onChange(on ? { ...cfg, enabled: true } : { ...cfg, enabled: false })
            }
          />
        </div>
      </CardHeader>
      {enabled && (
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Employees — min</Label>
              <Input
                type="number"
                min={0}
                value={cfg.employeesMin}
                onChange={(e) => setField({ employeesMin: Number(e.target.value) || 0 })}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Employees — max</Label>
              <Input
                type="number"
                min={0}
                value={cfg.employeesMax}
                onChange={(e) => setField({ employeesMax: Number(e.target.value) || 0 })}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Revenue — min (MSEK)</Label>
              <Input
                type="number"
                min={0}
                step="0.1"
                value={toM(cfg.revenueMinSek)}
                onChange={(e) => setField({ revenueMinSek: fromM(Number(e.target.value) || 0) })}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Revenue — max (MSEK)</Label>
              <Input
                type="number"
                min={0}
                step="0.1"
                value={toM(cfg.revenueMaxSek)}
                onChange={(e) => setField({ revenueMaxSek: fromM(Number(e.target.value) || 0) })}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Current filter: {cfg.employeesMin}–{cfg.employeesMax} employees and{" "}
            {toM(cfg.revenueMinSek)}–{toM(cfg.revenueMaxSek)} MSEK revenue.
          </p>
        </CardContent>
      )}
    </Card>
  );
}

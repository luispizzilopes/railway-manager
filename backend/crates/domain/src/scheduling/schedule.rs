//! Agendas de ligar/desligar: janelas por dia da semana num fuso horário, cálculo de
//! ocorrências (com horário de verão) e seleção dos eventos a executar em cada ciclo.

use std::collections::{BTreeMap, HashSet};
use std::fmt;
use std::str::FromStr;

use chrono::{
    DateTime, Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc, Weekday,
};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};

use crate::catalog::{NAME_MAX, required_text};
use crate::ids::{
    EnvironmentId, OperationId, ProjectId, ScheduleId, ScheduleRunId, ServiceInstanceId,
};
use crate::operation::str_enum;
use crate::power::PowerKind;

const DAY: u32 = 24 * 60;
const WEEK: u32 = 7 * DAY;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum InvalidSchedule {
    #[error("{0}")]
    Name(String),
    #[error("selecione ao menos um dia da semana")]
    NoDays,
    #[error("adicione ao menos uma janela de horário")]
    NoWindows,
    #[error("horário inválido: '{0}' (use HH:MM)")]
    InvalidTime(String),
    #[error("a janela {0} tem duração zero (início igual ao fim)")]
    ZeroDuration(usize),
    #[error("fuso horário inválido: '{0}'")]
    InvalidTimezone(String),
    #[error("as janelas {0} e {1} se sobrepõem")]
    Overlap(usize, usize),
    #[error("selecione ao menos uma instância")]
    NoInstances,
}

/// Dias da semana como máscara de bits (bit 0 = segunda … bit 6 = domingo).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Weekdays(u8);

impl Weekdays {
    pub const ALL: Weekdays = Weekdays(0b111_1111);

    pub fn from_bits(bits: u8) -> Self {
        Self(bits & 0b111_1111)
    }

    pub fn from_days(days: &[Weekday]) -> Self {
        Self(
            days.iter()
                .fold(0, |acc, d| acc | (1 << d.num_days_from_monday())),
        )
    }

    pub fn bits(self) -> u8 {
        self.0
    }

    pub fn is_empty(self) -> bool {
        self.0 == 0
    }

    pub fn contains(self, day: Weekday) -> bool {
        self.0 & (1 << day.num_days_from_monday()) != 0
    }

    /// Índices 0 (segunda) a 6 (domingo) selecionados.
    pub fn indices(self) -> impl Iterator<Item = u32> {
        (0..7).filter(move |i| self.0 & (1 << i) != 0)
    }
}

/// Horário local em minutos desde 00:00.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct LocalTime(u16);

impl LocalTime {
    pub fn from_minutes(minutes: u16) -> Option<Self> {
        (u32::from(minutes) < DAY).then_some(Self(minutes))
    }

    pub fn minutes(self) -> u16 {
        self.0
    }

    fn naive(self) -> NaiveTime {
        NaiveTime::from_hms_opt(u32::from(self.0 / 60), u32::from(self.0 % 60), 0)
            .expect("hora válida")
    }
}

impl FromStr for LocalTime {
    type Err = InvalidSchedule;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let invalid = || InvalidSchedule::InvalidTime(s.to_owned());
        let (h, m) = s.trim().split_once(':').ok_or_else(invalid)?;
        if h.len() != 2 || m.len() != 2 {
            return Err(invalid());
        }
        let (h, m): (u16, u16) = (
            h.parse().map_err(|_| invalid())?,
            m.parse().map_err(|_| invalid())?,
        );
        if h > 23 || m > 59 {
            return Err(invalid());
        }
        Ok(Self(h * 60 + m))
    }
}

impl fmt::Display for LocalTime {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:02}:{:02}", self.0 / 60, self.0 % 60)
    }
}

impl Serialize for LocalTime {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for LocalTime {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        String::deserialize(d)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}

/// Janela "ligado": inicia em `start` e desliga em `end`. `end < start` termina no
/// dia seguinte.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Window {
    pub start: LocalTime,
    pub end: LocalTime,
}

impl Window {
    pub fn crosses_midnight(self) -> bool {
        self.end < self.start
    }

    /// Duração em minutos (0 se início = fim).
    pub fn duration(self) -> u32 {
        let (s, e) = (u32::from(self.start.0), u32::from(self.end.0));
        if e >= s { e - s } else { DAY - s + e }
    }
}

/// O que a agenda liga/desliga dentro do projeto.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ScheduleTarget {
    /// Todas as instâncias gerenciadas do projeto (lidas no momento do evento),
    /// opcionalmente só de um ambiente.
    Project {
        environment_id: Option<EnvironmentId>,
    },
    /// Instâncias selecionadas.
    Instances {
        instance_ids: Vec<ServiceInstanceId>,
    },
}

pub fn parse_timezone(name: &str) -> Result<Tz, InvalidSchedule> {
    name.trim()
        .parse::<Tz>()
        .map_err(|_| InvalidSchedule::InvalidTimezone(name.to_owned()))
}

#[derive(Debug, Clone, PartialEq)]
pub struct Schedule {
    pub id: ScheduleId,
    pub project_id: ProjectId,
    pub name: String,
    pub enabled: bool,
    pub timezone: Tz,
    pub days: Weekdays,
    pub windows: Vec<Window>,
    pub target: ScheduleTarget,
    /// Eventos até este instante nunca são executados nem recuperados (criação,
    /// edição e retomada valem dali em diante).
    pub effective_from: DateTime<Utc>,
    pub paused_reason: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Dados editáveis de uma agenda.
#[derive(Debug, Clone, PartialEq)]
pub struct ScheduleSpec {
    pub name: String,
    pub timezone: Tz,
    pub days: Weekdays,
    pub windows: Vec<Window>,
    pub target: ScheduleTarget,
}

impl ScheduleSpec {
    /// Valida nome, dias, janelas (duração e sobreposição) e alvo.
    pub fn validate(mut self) -> Result<Self, InvalidSchedule> {
        self.name = required_text("nome da agenda", &self.name, NAME_MAX)
            .map_err(|e| InvalidSchedule::Name(e.to_string()))?;
        if self.days.is_empty() {
            return Err(InvalidSchedule::NoDays);
        }
        if self.windows.is_empty() {
            return Err(InvalidSchedule::NoWindows);
        }
        if let Some(i) = self.windows.iter().position(|w| w.duration() == 0) {
            return Err(InvalidSchedule::ZeroDuration(i + 1));
        }
        if let Some((a, b)) = first_overlap(self.days, &self.windows) {
            return Err(InvalidSchedule::Overlap(a + 1, b + 1));
        }
        if let ScheduleTarget::Instances { instance_ids } = &mut self.target {
            let mut seen = HashSet::new();
            instance_ids.retain(|id| seen.insert(*id));
            if instance_ids.is_empty() {
                return Err(InvalidSchedule::NoInstances);
            }
        }
        Ok(self)
    }
}

impl Schedule {
    pub fn new(
        project_id: ProjectId,
        spec: ScheduleSpec,
        now: DateTime<Utc>,
    ) -> Result<Self, InvalidSchedule> {
        let spec = spec.validate()?;
        Ok(Self {
            id: ScheduleId::new(),
            project_id,
            name: spec.name,
            enabled: true,
            timezone: spec.timezone,
            days: spec.days,
            windows: spec.windows,
            target: spec.target,
            effective_from: now,
            paused_reason: None,
            created_at: now,
            updated_at: now,
        })
    }

    /// Edição: vale a partir de agora, sem recuperar eventos anteriores.
    pub fn update(
        &mut self,
        spec: ScheduleSpec,
        now: DateTime<Utc>,
    ) -> Result<(), InvalidSchedule> {
        let spec = spec.validate()?;
        self.name = spec.name;
        self.timezone = spec.timezone;
        self.days = spec.days;
        self.windows = spec.windows;
        self.target = spec.target;
        self.effective_from = now;
        self.updated_at = now;
        Ok(())
    }

    pub fn pause(&mut self, reason: Option<String>, now: DateTime<Utc>) {
        self.enabled = false;
        self.paused_reason = reason;
        self.updated_at = now;
    }

    /// Retomar não recupera eventos ocorridos durante a pausa.
    pub fn resume(&mut self, now: DateTime<Utc>) {
        self.enabled = true;
        self.paused_reason = None;
        self.effective_from = now;
        self.updated_at = now;
    }
}

/// Intervalos semanais (minutos desde segunda 00:00) de cada janela em cada dia.
fn weekly_intervals(days: Weekdays, windows: &[Window]) -> Vec<(usize, u32, u32)> {
    let mut out = Vec::new();
    for (i, w) in windows.iter().enumerate() {
        for day in days.indices() {
            let start = day * DAY + u32::from(w.start.0);
            let end = start + w.duration();
            if end <= WEEK {
                out.push((i, start, end));
            } else {
                // Atravessa domingo → segunda.
                out.push((i, start, WEEK));
                out.push((i, 0, end - WEEK));
            }
        }
    }
    out
}

/// Primeiro par de janelas (índices) que se sobrepõem em algum dia; encostar
/// (fim de uma = início da outra) não é sobreposição.
pub fn first_overlap(days: Weekdays, windows: &[Window]) -> Option<(usize, usize)> {
    let intervals = weekly_intervals(days, windows);
    let mut found: Option<(usize, usize)> = None;
    for (n, &(a, s1, e1)) in intervals.iter().enumerate() {
        for &(b, s2, e2) in &intervals[n + 1..] {
            if a != b && s1 < e2 && s2 < e1 {
                let pair = (a.min(b), a.max(b));
                found = Some(found.map_or(pair, |f| f.min(pair)));
            }
        }
    }
    found
}

/// Um evento de agenda: iniciar ou desligar num instante.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Occurrence {
    pub at: DateTime<Utc>,
    pub action: PowerKind,
    pub window: usize,
}

/// Converte horário local em UTC. Horário inexistente (adiantamento do relógio) →
/// primeiro instante válido depois dele; ambíguo (atraso) → a primeira ocorrência.
pub fn local_to_utc(tz: Tz, local: NaiveDateTime) -> DateTime<Utc> {
    let mut candidate = local;
    for _ in 0..=24 * 60 {
        match tz.from_local_datetime(&candidate) {
            chrono::LocalResult::Single(t) => return t.with_timezone(&Utc),
            chrono::LocalResult::Ambiguous(first, _) => return first.with_timezone(&Utc),
            chrono::LocalResult::None => candidate += Duration::minutes(1),
        }
    }
    Utc.from_utc_datetime(&local)
}

/// Eventos da agenda com `from < at ≤ to`, em ordem cronológica.
pub fn occurrences(
    tz: Tz,
    days: Weekdays,
    windows: &[Window],
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Vec<Occurrence> {
    if to <= from {
        return vec![];
    }
    let first_day = from.with_timezone(&tz).date_naive() - Duration::days(2);
    let last_day = to.with_timezone(&tz).date_naive() + Duration::days(1);
    let mut out = Vec::new();
    let mut day = first_day;
    while day <= last_day {
        if days.contains(day.weekday()) {
            for (i, w) in windows.iter().enumerate() {
                let start = local_to_utc(tz, day.and_time(w.start.naive()));
                let end_day: NaiveDate = if w.crosses_midnight() {
                    day + Duration::days(1)
                } else {
                    day
                };
                let end = local_to_utc(tz, end_day.and_time(w.end.naive()));
                for (at, action) in [(start, PowerKind::Start), (end, PowerKind::Stop)] {
                    if at > from && at <= to {
                        out.push(Occurrence {
                            at,
                            action,
                            window: i,
                        });
                    }
                }
            }
        }
        day += Duration::days(1);
    }
    out.sort_by_key(|o| (o.at, o.action == PowerKind::Start, o.window));
    out
}

/// Próximos `n` eventos depois de `now`.
pub fn next_occurrences(
    tz: Tz,
    days: Weekdays,
    windows: &[Window],
    now: DateTime<Utc>,
    n: usize,
) -> Vec<Occurrence> {
    let mut out = Vec::new();
    let mut from = now;
    // Até ~3 meses à frente: suficiente para qualquer combinação de dias.
    for _ in 0..13 {
        let to = from + Duration::days(7);
        out.extend(occurrences(tz, days, windows, from, to));
        if out.len() >= n {
            break;
        }
        from = to;
    }
    out.truncate(n);
    out
}

/// Como um evento devido deve ser tratado neste ciclo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DueKind {
    /// Executar; `late` quando acontece bem depois do horário previsto.
    Execute { late: bool },
    /// Perdido: mais antigo que o mais recente, ou fora do limite de recuperação.
    Missed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DueEvent {
    pub schedule_id: ScheduleId,
    pub occurrence: Occurrence,
    pub kind: DueKind,
}

/// Eventos de uma agenda entre a última avaliação e `now`. Só o instante mais
/// recente é executado (se dentro de `catchup`); os anteriores ficam perdidos.
pub fn due_events(
    schedule: &Schedule,
    last_evaluated: DateTime<Utc>,
    now: DateTime<Utc>,
    catchup: Duration,
    late_after: Duration,
) -> Vec<DueEvent> {
    if !schedule.enabled {
        return vec![];
    }
    let from = last_evaluated.max(schedule.effective_from);
    let events = occurrences(
        schedule.timezone,
        schedule.days,
        &schedule.windows,
        from,
        now,
    );
    let Some(latest) = events.last().map(|o| o.at) else {
        return vec![];
    };
    events
        .into_iter()
        .map(|occurrence| {
            let kind = if occurrence.at == latest && now - occurrence.at <= catchup {
                DueKind::Execute {
                    late: now - occurrence.at > late_after,
                }
            } else {
                DueKind::Missed
            };
            DueEvent {
                schedule_id: schedule.id,
                occurrence,
                kind,
            }
        })
        .collect()
}

/// Evento a executar com as instâncias já resolvidas.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventTargets {
    pub schedule_id: ScheduleId,
    pub at: DateTime<Utc>,
    pub action: PowerKind,
    pub instances: Vec<ServiceInstanceId>,
}

/// Instância retirada de um *desligar* porque outra agenda a inicia no mesmo instante.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Conflict {
    pub instance: ServiceInstanceId,
    pub starting_schedule: ScheduleId,
}

/// No mesmo instante, *iniciar* prevalece sobre *desligar* para a mesma instância.
pub fn resolve_conflicts(events: Vec<EventTargets>) -> Vec<(EventTargets, Vec<Conflict>)> {
    let mut starts: BTreeMap<(DateTime<Utc>, ServiceInstanceId), ScheduleId> = BTreeMap::new();
    for e in events.iter().filter(|e| e.action == PowerKind::Start) {
        for i in &e.instances {
            starts.entry((e.at, *i)).or_insert(e.schedule_id);
        }
    }
    events
        .into_iter()
        .map(|mut e| {
            let mut conflicts = Vec::new();
            if e.action == PowerKind::Stop {
                e.instances.retain(|i| match starts.get(&(e.at, *i)) {
                    Some(&starting_schedule) => {
                        conflicts.push(Conflict {
                            instance: *i,
                            starting_schedule,
                        });
                        false
                    }
                    None => true,
                });
            }
            (e, conflicts)
        })
        .collect()
}

/// Situação de um evento processado pelo agendador.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    /// Registrado, aguardando a criação da operação.
    Pending,
    Executed,
    /// Executado bem depois do horário previsto (servidor estava fora do ar).
    Late,
    /// Nada a fazer (ex.: alvo vazio, todas as instâncias em conflito).
    Skipped,
    Missed,
    Failed,
}

str_enum!(RunStatus {
    Pending => "pending",
    Executed => "executed",
    Late => "late",
    Skipped => "skipped",
    Missed => "missed",
    Failed => "failed",
});

/// Registro de um evento de agenda processado.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScheduleRun {
    pub id: ScheduleRunId,
    pub schedule_id: ScheduleId,
    pub schedule_name: String,
    pub action: PowerKind,
    pub scheduled_for: DateTime<Utc>,
    pub processed_at: DateTime<Utc>,
    pub status: RunStatus,
    pub operation_id: Option<OperationId>,
    pub message: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use Weekday::*;

    fn t(s: &str) -> LocalTime {
        s.parse().unwrap()
    }

    fn w(a: &str, b: &str) -> Window {
        Window {
            start: t(a),
            end: t(b),
        }
    }

    fn utc(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().to_utc()
    }

    fn spec(days: Weekdays, windows: Vec<Window>) -> ScheduleSpec {
        ScheduleSpec {
            name: "comercial".into(),
            timezone: chrono_tz::America::Sao_Paulo,
            days,
            windows,
            target: ScheduleTarget::Project {
                environment_id: None,
            },
        }
    }

    fn weekdays() -> Weekdays {
        Weekdays::from_days(&[Mon, Tue, Wed, Thu, Fri])
    }

    // ---------- 1.1 construção ----------

    #[test]
    fn horarios_validos_e_invalidos() {
        assert_eq!(t("07:05").minutes(), 425);
        assert_eq!(t("23:59").to_string(), "23:59");
        for bad in ["7:00", "24:00", "12:60", "ab:cd", "1200", ""] {
            assert!(
                matches!(
                    bad.parse::<LocalTime>(),
                    Err(InvalidSchedule::InvalidTime(_))
                ),
                "{bad}"
            );
        }
    }

    #[test]
    fn fuso_invalido() {
        assert_eq!(
            parse_timezone("America/Sao_Paulo").unwrap(),
            chrono_tz::America::Sao_Paulo
        );
        assert_eq!(
            parse_timezone("Lua/Base"),
            Err(InvalidSchedule::InvalidTimezone("Lua/Base".into()))
        );
    }

    #[test]
    fn construcao_invalida() {
        let now = Utc::now();
        let p = ProjectId::new();
        let mut s = spec(weekdays(), vec![w("07:00", "12:00")]);
        s.name = "  ".into();
        assert!(matches!(
            Schedule::new(p, s, now),
            Err(InvalidSchedule::Name(_))
        ));
        assert_eq!(
            Schedule::new(p, spec(Weekdays::default(), vec![w("07:00", "12:00")]), now),
            Err(InvalidSchedule::NoDays)
        );
        assert_eq!(
            Schedule::new(p, spec(weekdays(), vec![]), now),
            Err(InvalidSchedule::NoWindows)
        );
        assert_eq!(
            Schedule::new(
                p,
                spec(weekdays(), vec![w("07:00", "12:00"), w("09:00", "09:00")]),
                now
            ),
            Err(InvalidSchedule::ZeroDuration(2))
        );
        let mut s = spec(weekdays(), vec![w("07:00", "12:00")]);
        s.target = ScheduleTarget::Instances {
            instance_ids: vec![],
        };
        assert_eq!(Schedule::new(p, s, now), Err(InvalidSchedule::NoInstances));
    }

    #[test]
    fn construcao_valida_remove_instancias_repetidas() {
        let id = ServiceInstanceId::new();
        let mut s = spec(weekdays(), vec![w("07:00", "12:00"), w("13:00", "18:00")]);
        s.target = ScheduleTarget::Instances {
            instance_ids: vec![id, id],
        };
        let schedule = Schedule::new(ProjectId::new(), s, Utc::now()).unwrap();
        assert_eq!(
            schedule.target,
            ScheduleTarget::Instances {
                instance_ids: vec![id]
            }
        );
        assert!(schedule.enabled);
    }

    #[test]
    fn pausa_edicao_e_retomada_atualizam_vigencia() {
        let t0 = utc("2026-11-17T10:00:00Z");
        let mut s = Schedule::new(
            ProjectId::new(),
            spec(weekdays(), vec![w("07:00", "12:00")]),
            t0,
        )
        .unwrap();
        s.pause(Some("manual".into()), t0 + Duration::hours(1));
        assert!(!s.enabled);
        s.resume(t0 + Duration::hours(2));
        assert!(s.enabled && s.paused_reason.is_none());
        assert_eq!(s.effective_from, t0 + Duration::hours(2));
        s.update(
            spec(weekdays(), vec![w("08:00", "12:00")]),
            t0 + Duration::hours(3),
        )
        .unwrap();
        assert_eq!(s.effective_from, t0 + Duration::hours(3));
    }

    // ---------- 1.2 sobreposição ----------

    #[test]
    fn tabela_de_sobreposicao() {
        let all = Weekdays::ALL;
        let cases = [
            (vec![w("07:00", "12:00"), w("11:00", "15:00")], Some((0, 1))),
            (vec![w("07:00", "12:00"), w("13:00", "18:00")], None),
            (vec![w("07:00", "12:00"), w("12:00", "18:00")], None),
            (vec![w("22:00", "02:00"), w("01:00", "03:00")], Some((0, 1))),
            (vec![w("22:00", "02:00"), w("02:00", "06:00")], None),
            (
                vec![
                    w("08:00", "09:00"),
                    w("10:00", "11:00"),
                    w("08:30", "08:45"),
                ],
                Some((0, 2)),
            ),
        ];
        for (windows, expected) in cases {
            assert_eq!(first_overlap(all, &windows), expected, "{windows:?}");
        }
    }

    #[test]
    fn sobreposicao_depende_dos_dias_e_vira_a_semana() {
        // 22–02 só na segunda não encosta no 01–03 da segunda de manhã.
        let mon = Weekdays::from_days(&[Mon]);
        assert_eq!(
            first_overlap(mon, &[w("22:00", "02:00"), w("01:00", "03:00")]),
            None
        );
        // Domingo 22–02 avança sobre segunda 01–03.
        let sun_mon = Weekdays::from_days(&[Sun, Mon]);
        assert_eq!(
            first_overlap(sun_mon, &[w("22:00", "02:00"), w("01:00", "03:00")]),
            Some((0, 1))
        );
        assert_eq!(
            Schedule::new(
                ProjectId::new(),
                spec(
                    Weekdays::ALL,
                    vec![w("07:00", "12:00"), w("11:00", "15:00")]
                ),
                Utc::now()
            ),
            Err(InvalidSchedule::Overlap(1, 2))
        );
    }

    // ---------- 1.3 ocorrências ----------

    fn local(tz: Tz, occ: &[Occurrence]) -> Vec<(String, PowerKind)> {
        occ.iter()
            .map(|o| {
                (
                    o.at.with_timezone(&tz).format("%a %d %H:%M").to_string(),
                    o.action,
                )
            })
            .collect()
    }

    #[test]
    fn duas_janelas_num_dia_util() {
        let tz = chrono_tz::America::Sao_Paulo;
        // Terça 17/11/2026, 00:00 local = 03:00Z.
        let from = utc("2026-11-17T03:00:00Z") - Duration::minutes(1);
        let to = utc("2026-11-18T03:00:00Z");
        let occ = occurrences(
            tz,
            weekdays(),
            &[w("07:00", "12:00"), w("13:00", "18:00")],
            from,
            to,
        );
        assert_eq!(
            local(tz, &occ),
            [
                ("Tue 17 07:00".into(), PowerKind::Start),
                ("Tue 17 12:00".into(), PowerKind::Stop),
                ("Tue 17 13:00".into(), PowerKind::Start),
                ("Tue 17 18:00".into(), PowerKind::Stop),
            ]
        );
        assert_eq!(occ[0].at, utc("2026-11-17T10:00:00Z"));
    }

    #[test]
    fn janela_que_atravessa_a_meia_noite() {
        let tz = chrono_tz::America::Sao_Paulo;
        let fri = Weekdays::from_days(&[Fri]);
        let occ = occurrences(
            tz,
            fri,
            &[w("22:00", "02:00")],
            utc("2026-11-20T00:00:00Z"),
            utc("2026-11-23T00:00:00Z"),
        );
        assert_eq!(
            local(tz, &occ),
            [
                ("Fri 20 22:00".into(), PowerKind::Start),
                ("Sat 21 02:00".into(), PowerKind::Stop)
            ]
        );
    }

    #[test]
    fn proximas_cinco_numa_sexta_as_dez() {
        let tz = chrono_tz::America::Sao_Paulo;
        // Sexta 20/11/2026 10:00 local.
        let now = utc("2026-11-20T13:00:00Z");
        let next = next_occurrences(tz, weekdays(), &[w("07:00", "12:00")], now, 5);
        assert_eq!(
            local(tz, &next),
            [
                ("Fri 20 12:00".into(), PowerKind::Stop),
                ("Mon 23 07:00".into(), PowerKind::Start),
                ("Mon 23 12:00".into(), PowerKind::Stop),
                ("Tue 24 07:00".into(), PowerKind::Start),
                ("Tue 24 12:00".into(), PowerKind::Stop),
            ]
        );
    }

    #[test]
    fn horario_de_verao_gap_e_overlap() {
        let tz = chrono_tz::America::New_York;
        let all = Weekdays::ALL;
        // 08/03/2026: 02:00 → 03:00 (02:30 não existe) — vai para 03:00 local.
        let gap = occurrences(
            tz,
            all,
            &[w("02:30", "05:00")],
            utc("2026-03-08T05:00:00Z"),
            utc("2026-03-08T12:00:00Z"),
        );
        assert_eq!(gap[0].at, utc("2026-03-08T07:00:00Z"));
        assert_eq!(
            gap[0].at.with_timezone(&tz).format("%H:%M").to_string(),
            "03:00"
        );
        // 01/11/2026: 01:30 acontece duas vezes — usa a primeira (EDT, UTC-4).
        let overlap = occurrences(
            tz,
            all,
            &[w("01:30", "05:00")],
            utc("2026-11-01T04:00:00Z"),
            utc("2026-11-01T12:00:00Z"),
        );
        assert_eq!(overlap[0].at, utc("2026-11-01T05:30:00Z"));
        assert_eq!(
            overlap
                .iter()
                .filter(|o| o.action == PowerKind::Start)
                .count(),
            1
        );
    }

    // ---------- 1.4 eventos do ciclo e conflitos ----------

    fn schedule_at(effective: &str) -> Schedule {
        let mut s = Schedule::new(
            ProjectId::new(),
            spec(
                Weekdays::ALL,
                vec![w("07:00", "12:00"), w("13:00", "18:00")],
            ),
            utc(effective),
        )
        .unwrap();
        s.timezone = chrono_tz::UTC;
        s
    }

    fn kinds(events: &[DueEvent]) -> Vec<(String, DueKind)> {
        events
            .iter()
            .map(|e| (e.occurrence.at.format("%H:%M").to_string(), e.kind))
            .collect()
    }

    #[test]
    fn evento_no_horario_e_executado() {
        let s = schedule_at("2026-11-17T00:00:00Z");
        let due = due_events(
            &s,
            utc("2026-11-17T06:59:40Z"),
            utc("2026-11-17T07:00:10Z"),
            Duration::minutes(30),
            Duration::seconds(60),
        );
        assert_eq!(
            kinds(&due),
            [("07:00".into(), DueKind::Execute { late: false })]
        );
    }

    #[test]
    fn volta_dentro_do_limite_executa_atrasado() {
        let s = schedule_at("2026-11-17T00:00:00Z");
        let due = due_events(
            &s,
            utc("2026-11-17T06:55:00Z"),
            utc("2026-11-17T07:10:00Z"),
            Duration::minutes(30),
            Duration::seconds(60),
        );
        assert_eq!(
            kinds(&due),
            [("07:00".into(), DueKind::Execute { late: true })]
        );
    }

    #[test]
    fn volta_fora_do_limite_so_executa_o_mais_recente() {
        let s = schedule_at("2026-11-17T00:00:00Z");
        let due = due_events(
            &s,
            utc("2026-11-17T06:00:00Z"),
            utc("2026-11-17T13:30:00Z"),
            Duration::minutes(30),
            Duration::seconds(60),
        );
        assert_eq!(
            kinds(&due),
            [
                ("07:00".into(), DueKind::Missed),
                ("12:00".into(), DueKind::Missed),
                ("13:00".into(), DueKind::Execute { late: true }),
            ]
        );
        // Mais recente também fora do limite: tudo perdido.
        let due = due_events(
            &s,
            utc("2026-11-17T06:00:00Z"),
            utc("2026-11-17T14:00:00Z"),
            Duration::minutes(30),
            Duration::seconds(60),
        );
        assert!(due.iter().all(|e| e.kind == DueKind::Missed));
    }

    #[test]
    fn pausada_ou_antes_da_vigencia_nao_gera_eventos() {
        let mut s = schedule_at("2026-11-17T07:05:00Z");
        // Vigência começou depois das 07:00: o evento das 07:00 não é recuperado.
        let due = due_events(
            &s,
            utc("2026-11-17T06:00:00Z"),
            utc("2026-11-17T07:10:00Z"),
            Duration::minutes(30),
            Duration::seconds(60),
        );
        assert!(due.is_empty());
        s.pause(None, utc("2026-11-17T08:00:00Z"));
        let due = due_events(
            &s,
            utc("2026-11-17T11:59:00Z"),
            utc("2026-11-17T12:00:30Z"),
            Duration::minutes(30),
            Duration::seconds(60),
        );
        assert!(due.is_empty());
    }

    #[test]
    fn iniciar_prevalece_sobre_desligar_no_mesmo_instante() {
        let (a, b) = (ScheduleId::new(), ScheduleId::new());
        let (api, web) = (ServiceInstanceId::new(), ServiceInstanceId::new());
        let at = utc("2026-11-17T12:00:00Z");
        let resolved = resolve_conflicts(vec![
            EventTargets {
                schedule_id: a,
                at,
                action: PowerKind::Stop,
                instances: vec![api, web],
            },
            EventTargets {
                schedule_id: b,
                at,
                action: PowerKind::Start,
                instances: vec![api],
            },
        ]);
        assert_eq!(resolved[0].0.instances, vec![web]);
        assert_eq!(
            resolved[0].1,
            vec![Conflict {
                instance: api,
                starting_schedule: b
            }]
        );
        assert_eq!(resolved[1].0.instances, vec![api]);
        assert!(resolved[1].1.is_empty());

        // Instantes diferentes não conflitam.
        let other = resolve_conflicts(vec![
            EventTargets {
                schedule_id: a,
                at,
                action: PowerKind::Stop,
                instances: vec![api],
            },
            EventTargets {
                schedule_id: b,
                at: at + Duration::minutes(1),
                action: PowerKind::Start,
                instances: vec![api],
            },
        ]);
        assert_eq!(other[0].0.instances, vec![api]);
    }
}

export const COLUMNS = [
  { id: 'backlog', name: 'Backlog' },
  { id: 'progress', name: 'In progress' },
  { id: 'review', name: 'In review' },
  { id: 'done', name: 'Done' },
];

export const TAGS = {
  design: 'Design',
  frontend: 'Frontend',
  backend: 'Backend',
  bug: 'Bug',
  research: 'Research',
  docs: 'Docs',
};

export const PRIORITIES = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' };

export const PEOPLE = {
  maya: { name: 'Maya Chen', color: '#c4553a' },
  leo: { name: 'Leo Park', color: '#3d72a6' },
  ines: { name: 'Ines Duarte', color: '#2b8274' },
  sam: { name: 'Sam Okafor', color: '#8a5288' },
  rae: { name: 'Rae Lindqvist', color: '#a8792a' },
  me: { name: 'Jordan Reyes', color: '#56803f' },
};

export const TASKS = [
  {
    id: 'ORB-118',
    title: 'Onboarding checklist for new workspaces',
    status: 'backlog',
    tags: ['design'],
    priority: 'medium',
    assignee: 'maya',
    comments: 4,
    due: 'Nov 28',
    created: 'Nov 4',
    description:
      'Guide new admins through inviting teammates, creating a first project and connecting a calendar. Keep it to five steps.',
  },
  {
    id: 'ORB-124',
    title: 'Export reports as CSV',
    status: 'backlog',
    tags: ['backend'],
    priority: 'low',
    assignee: 'leo',
    comments: 1,
    due: 'Dec 2',
    created: 'Nov 6',
    description:
      'Let workspace owners download the analytics tables as CSV. Respect the active filters and the time zone of the workspace.',
  },
  {
    id: 'ORB-131',
    title: 'Shortcuts cheat sheet',
    status: 'backlog',
    tags: ['docs'],
    priority: 'low',
    assignee: 'rae',
    comments: 0,
    due: 'Dec 5',
    created: 'Nov 10',
    description: 'A printable page that lists every keyboard shortcut, grouped by area.',
  },
  {
    id: 'ORB-112',
    title: 'Polish the billing page layout',
    status: 'progress',
    tags: ['design'],
    priority: 'high',
    assignee: 'ines',
    comments: 7,
    due: 'Nov 21',
    created: 'Nov 3',
    description:
      'Align the plan cards, tighten the invoice table and add an empty state for workspaces without invoices.',
  },
  {
    id: 'ORB-127',
    title: 'Live presence indicators',
    status: 'progress',
    tags: ['frontend'],
    priority: 'high',
    assignee: 'sam',
    comments: 3,
    due: 'Nov 24',
    created: 'Nov 5',
    description:
      'Show who else is looking at a task, with avatars in the panel header. Fade them out after two minutes of inactivity.',
  },
  {
    id: 'ORB-133',
    title: 'Rate limiting for the public API',
    status: 'progress',
    tags: ['backend'],
    priority: 'urgent',
    assignee: 'leo',
    comments: 5,
    due: 'Nov 20',
    created: 'Nov 7',
    description:
      'Add per-token limits with clear 429 responses and Retry-After headers. Start with 600 requests per minute.',
  },
  {
    id: 'ORB-136',
    title: 'Fix timezone drift in due dates',
    status: 'review',
    tags: ['bug'],
    priority: 'urgent',
    assignee: 'maya',
    comments: 9,
    due: 'Nov 19',
    created: 'Nov 8',
    description:
      'Due dates shift by one day for teammates west of UTC. Store them as calendar days, not timestamps.',
  },
  {
    id: 'ORB-140',
    title: 'Interview notes from pilot customers',
    status: 'review',
    tags: ['research'],
    priority: 'medium',
    assignee: 'rae',
    comments: 2,
    due: 'Nov 22',
    created: 'Nov 11',
    description:
      'Summarize the six pilot interviews and tag the recurring requests for the roadmap review.',
  },
  {
    id: 'ORB-104',
    title: 'Dark mode for reports',
    status: 'done',
    tags: ['frontend'],
    priority: 'medium',
    assignee: 'ines',
    comments: 6,
    due: 'Nov 14',
    created: 'Oct 27',
    description:
      'Use the shared color tokens in the report views so that charts and tables follow the theme.',
  },
  {
    id: 'ORB-109',
    title: 'Migrate auth to session tokens',
    status: 'done',
    tags: ['backend'],
    priority: 'high',
    assignee: 'sam',
    comments: 8,
    due: 'Nov 12',
    created: 'Oct 29',
    description:
      'Replace long-lived cookies with rotating session tokens. Sign out every device on a password change.',
  },
  {
    id: 'ORB-115',
    title: 'Write the API changelog',
    status: 'done',
    tags: ['docs'],
    priority: 'low',
    assignee: 'me',
    comments: 1,
    due: 'Nov 13',
    created: 'Nov 1',
    description:
      'Document the breaking changes in v2 and add a migration example for each endpoint.',
  },
];

export const STATS = [
  {
    id: 'completed',
    label: 'Tasks completed',
    value: 186,
    delta: '+12.4%',
    trend: 'up',
    good: true,
  },
  {
    id: 'cycle-time',
    label: 'Avg. cycle time',
    value: 3.4,
    decimals: 1,
    unit: 'days',
    delta: '−0.6 days',
    trend: 'down',
    good: true,
  },
  {
    id: 'on-time',
    label: 'On-time delivery',
    value: 94,
    suffix: '%',
    delta: '+3 pts',
    trend: 'up',
    good: true,
  },
  { id: 'open', label: 'Open tasks', value: 37, delta: '+4', trend: 'up', good: false },
];

export const WEEKLY = [
  { label: 'Aug 25', value: 10 },
  { label: 'Sep 1', value: 12 },
  { label: 'Sep 8', value: 9 },
  { label: 'Sep 15', value: 14 },
  { label: 'Sep 22', value: 13 },
  { label: 'Sep 29', value: 16 },
  { label: 'Oct 6', value: 15 },
  { label: 'Oct 13', value: 18 },
  { label: 'Oct 20', value: 17 },
  { label: 'Oct 27', value: 20 },
  { label: 'Nov 3', value: 19 },
  { label: 'Nov 10', value: 23 },
];

export const TEAM = [
  { person: 'maya', open: 6, done: 42, cycle: 2.9 },
  { person: 'leo', open: 8, done: 35, cycle: 3.8 },
  { person: 'ines', open: 4, done: 39, cycle: 3.1 },
  { person: 'sam', open: 7, done: 31, cycle: 4.2 },
  { person: 'rae', open: 5, done: 27, cycle: 3.5 },
  { person: 'me', open: 7, done: 12, cycle: 2.6 },
];

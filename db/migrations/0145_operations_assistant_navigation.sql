-- Add the two operational workspace links to the persisted Assistant router.
-- These skills expose only module_link; stock and assets still change via UI.
ALTER TABLE ai_inquiry_skill DROP CONSTRAINT ai_inquiry_skill_skill_check;
ALTER TABLE ai_inquiry_skill ADD CONSTRAINT ai_inquiry_skill_skill_check CHECK (skill IN (
  'books', 'crm', 'transactions', 'invoices', 'banking', 'journal', 'parties', 'accounts',
  'reports', 'tax', 'payroll', 'records', 'periods', 'opening', 'sred', 'backup',
  'cheques', 'documents', 'projects', 'automation', 'inventory', 'assets'
));

-- Navigation-only skills must persist their routing decision just like Books/CRM.
ALTER TABLE ai_inquiry_skill DROP CONSTRAINT ai_inquiry_skill_skill_check;
ALTER TABLE ai_inquiry_skill ADD CONSTRAINT ai_inquiry_skill_skill_check CHECK (skill IN (
  'books', 'crm', 'transactions', 'invoices', 'banking', 'journal', 'parties', 'accounts',
  'reports', 'tax', 'payroll', 'records', 'periods', 'opening', 'sred', 'backup',
  'cheques', 'documents', 'projects'
));

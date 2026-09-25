// A company's certificates (renewals), soonest audit first. Returns a new array.
window.companyRenewals = function companyRenewals(renewals, companyId) {
  return renewals
    .filter(r => r.company_id === companyId)
    .sort((a, b) => new Date(a.audit_due) - new Date(b.audit_due));
};

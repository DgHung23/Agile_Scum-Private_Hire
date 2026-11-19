import { useState } from 'react';
import { api, qs } from '../../api.js';
import { Icon } from '../../icons.jsx';
import { Alert, Empty, Loading, Modal, PageHeader, SelectField, TextField, useLoad, useToast } from '../../ui.jsx';
import { v, validate } from '../../validators.js';

/** Small modal form used for both cabs and drivers. `fields` = [{key,label,type,rules,options?,hint?}] */
function EntityModal({ title, fields, initial, onSave, onClose }) {
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const rules = Object.fromEntries(fields.map((f) => [f.key, f.rule]));

  const submit = async (e) => {
    e.preventDefault();
    setFormError('');
    const errs = validate(values, rules);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await onSave(values);
    } catch (err) {
      setErrors(err.fields || {});
      setFormError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal title={title} onClose={onClose}>
      <form className="stack" onSubmit={submit} noValidate>
        {formError && <Alert tone="error">{formError}</Alert>}
        {fields.map((f) =>
          f.options ? (
            <SelectField key={f.key} label={f.label} value={values[f.key]} error={errors[f.key]}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>
              <option value="">Choose...</option>
              {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </SelectField>
          ) : (
            <TextField key={f.key} label={f.label} value={values[f.key]} error={errors[f.key]} hint={f.hint}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
          ),
        )}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-subtle" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn" disabled={busy}>{busy ? 'Saving...' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function StaffFleet() {
  const toast = useToast();
  const [filters, setFilters] = useState({ q: '', size: '', active: '' });
  const sizes = useLoad(() => api.publicGet('/catalog/cab-sizes'));
  const { data, loading, error, reload } = useLoad(() => api.get('/staff/cabs' + qs(filters)), [filters.q, filters.size, filters.active]);
  const [modal, setModal] = useState(null); // {cab?}

  const sizeOptions = (sizes.data?.cabSizes || []).map((s) => ({ value: s.code, label: s.label }));
  const fields = [
    { key: 'reg', label: 'Registration number', rule: v.required('Registration number'), hint: 'Must be unique, e.g. LK21 ABC' },
    { key: 'make', label: 'Make', rule: v.required('Make') },
    { key: 'model', label: 'Model', rule: v.required('Model') },
    { key: 'colour', label: 'Colour', rule: v.required('Colour') },
    { key: 'sizeCode', label: 'Cab size', rule: v.required('Cab size'), options: sizeOptions },
  ];

  const save = (cab) => async (values) => {
    if (cab) await api.patch(`/staff/cabs/${cab.id}`, { ...values, active: cab.active });
    else await api.post('/staff/cabs', values);
    toast(cab ? 'Cab updated' : 'Cab added', 'success');
    setModal(null);
    reload();
  };

  const toggle = async (c) => {
    try {
      await api.patch(`/staff/cabs/${c.id}`, { reg: c.reg, make: c.make, model: c.model, colour: c.colour, sizeCode: c.sizeCode, active: !c.active });
      toast(c.active ? `${c.reg} deactivated` : `${c.reg} reactivated`, 'success');
      reload();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  return (
    <div className="stack-lg">
      <PageHeader title="Fleet" sub="Add, edit and deactivate minicabs. Only active cabs can be booked."
        actions={<button className="btn" onClick={() => setModal({})}><Icon name="plus" size={18} /> Add cab</button>} />
      <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
        <TextField label="Search" placeholder="Registration, make or model" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
        <SelectField label="Size" value={filters.size} onChange={(e) => setFilters({ ...filters, size: e.target.value })}>
          <option value="">All sizes</option>
          {sizeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </SelectField>
        <SelectField label="Status" value={filters.active} onChange={(e) => setFilters({ ...filters, active: e.target.value })}>
          <option value="">All</option>
          <option value="true">Active</option>
          <option value="false">Inactive</option>
        </SelectField>
      </div>
      {loading && !data && <Loading />}
      {error && <Alert tone="error">{error.message}</Alert>}
      {data && data.cabs.length === 0 && <Empty icon="car" title="No cabs match">Try a different search or add a cab.</Empty>}
      {data && data.cabs.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Registration</th><th>Vehicle</th><th>Colour</th><th>Size</th><th>Upcoming</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {data.cabs.map((c) => (
                <tr key={c.id}>
                  <td className="strong mono">{c.reg}</td>
                  <td>{c.make} {c.model}</td>
                  <td>{c.colour}</td>
                  <td>{c.sizeLabel}</td>
                  <td>{c.upcomingBookings}</td>
                  <td><span className={`badge ${c.active ? 'green' : ''}`}>{c.active ? 'Active' : 'Inactive'}</span></td>
                  <td>
                    <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                      <button className="btn btn-subtle btn-sm" onClick={() => setModal({ cab: c })}>Edit</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => toggle(c)}>{c.active ? 'Deactivate' : 'Reactivate'}</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="tiny">{data ? `${data.cabs.length} cab${data.cabs.length === 1 ? '' : 's'} shown` : ''}</p>
      {modal && (
        <EntityModal
          title={modal.cab ? `Edit ${modal.cab.reg}` : 'Add a cab'}
          fields={fields}
          initial={modal.cab ? { reg: modal.cab.reg, make: modal.cab.make, model: modal.cab.model, colour: modal.cab.colour, sizeCode: modal.cab.sizeCode } : { reg: '', make: '', model: '', colour: '', sizeCode: '' }}
          onSave={save(modal.cab)}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

export function StaffDrivers() {
  const toast = useToast();
  const [filters, setFilters] = useState({ q: '', active: '' });
  const { data, loading, error, reload } = useLoad(() => api.get('/staff/drivers' + qs(filters)), [filters.q, filters.active]);
  const [modal, setModal] = useState(null);

  const fields = [
    { key: 'fullName', label: 'Full name', rule: v.required('Full name') },
    { key: 'phone', label: 'Telephone', rule: v.phone },
    { key: 'licenceNo', label: 'Licence number', rule: v.required('Licence number'), hint: 'Must be unique' },
  ];

  const save = (driver) => async (values) => {
    if (driver) await api.patch(`/staff/drivers/${driver.id}`, { ...values, active: driver.active });
    else await api.post('/staff/drivers', values);
    toast(driver ? 'Driver updated' : 'Driver added', 'success');
    setModal(null);
    reload();
  };
  const toggle = async (d) => {
    try {
      await api.patch(`/staff/drivers/${d.id}`, { fullName: d.fullName, phone: d.phone, licenceNo: d.licenceNo, active: !d.active });
      toast(d.active ? `${d.fullName} deactivated` : `${d.fullName} reactivated`, 'success');
      reload();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  return (
    <div className="stack-lg">
      <PageHeader title="Drivers" sub="Drivers who can be assigned to bookings."
        actions={<button className="btn" onClick={() => setModal({})}><Icon name="plus" size={18} /> Add driver</button>} />
      <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
        <TextField label="Search" placeholder="Name or licence number" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
        <SelectField label="Status" value={filters.active} onChange={(e) => setFilters({ ...filters, active: e.target.value })}>
          <option value="">All</option>
          <option value="true">Active</option>
          <option value="false">Inactive</option>
        </SelectField>
      </div>
      {loading && !data && <Loading />}
      {error && <Alert tone="error">{error.message}</Alert>}
      {data && data.drivers.length === 0 && <Empty icon="wheel" title="No drivers match" />}
      {data && data.drivers.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Name</th><th>Telephone</th><th>Licence</th><th>Upcoming jobs</th><th>Status</th><th /></tr></thead>
            <tbody>
              {data.drivers.map((d) => (
                <tr key={d.id}>
                  <td className="strong">{d.fullName}</td>
                  <td>{d.phone}</td>
                  <td className="mono">{d.licenceNo}</td>
                  <td>{d.upcomingBookings}</td>
                  <td><span className={`badge ${d.active ? 'green' : ''}`}>{d.active ? 'Active' : 'Inactive'}</span></td>
                  <td>
                    <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                      <button className="btn btn-subtle btn-sm" onClick={() => setModal({ driver: d })}>Edit</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => toggle(d)}>{d.active ? 'Deactivate' : 'Reactivate'}</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {modal && (
        <EntityModal
          title={modal.driver ? `Edit ${modal.driver.fullName}` : 'Add a driver'}
          fields={fields}
          initial={modal.driver ? { fullName: modal.driver.fullName, phone: modal.driver.phone, licenceNo: modal.driver.licenceNo } : { fullName: '', phone: '', licenceNo: '' }}
          onSave={save(modal.driver)}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

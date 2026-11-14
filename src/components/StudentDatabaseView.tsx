import {
  ArrowUpDown,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Edit3,
  Eye,
  FileSpreadsheet,
  Lock,
  Plus,
  Search,
  ShieldCheck,
  ShieldOff,
  Trash2,
  Unlock,
  Upload,
  Users,
  X,
} from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { CANONICAL_CENTRES, CENTRE_MAP } from '../constants/centres';
import { exportToCsv, exportToExcel } from '../lib/csvUtils';
import { verifyOperationLocation } from '../lib/securityClient';
import {
  bulkSetStudentSuperAdminAccess,
  checkDuplicateStudent,
  createStudentRecord,
  deleteStudentRecord,
  getNextSerialNumber,
  toggleStudentEmployeeLock,
  toggleStudentSuperAdminAccess,
  updateStudentRecord,
} from '../services/firestoreService';
import type {
  CentreId,
  ClassAttendanceStatus,
  PracticalStatus,
  Student,
  TmaStatus,
  UserAccount,
} from '../types/domain';
import { BulkImportModal } from './BulkImportModal';
import { ConfirmDialog } from './ConfirmDialog';
import { StudentFormModal } from './StudentFormModal';
import { StudentProfileModal } from './StudentProfileModal';

interface StudentDatabaseViewProps {
  students: Student[];
  employees: UserAccount[];
  currentUser: UserAccount;
  selectedCentreFilter: CentreId | 'all';
  globalSearch: string;
  loading: boolean;
  onNotify: (title: string, description: string, variant: 'success' | 'error' | 'warning' | 'info') => void;
}

type SortKey = 'serialNumber' | 'studentName' | 'tmaStatus' | 'practicalStatus' | 'classAttendanceStatus';

export function canUserEditStudentRow(student: Student, user: UserAccount): boolean {
  if (user.role === 'centre_head') {
    return student.centreId === user.centreId;
  }
  if (user.role === 'super_admin') {
    return student.superAdminAccessGranted !== false;
  }
  // Employee fill-once rule: once locked/filled, employee cannot re-edit
  if (user.role === 'employee') {
    if (student.centreId !== user.centreId) return false;
    return !student.employeeLocked;
  }
  return false;
}

export const StudentDatabaseView: React.FC<StudentDatabaseViewProps> = ({
  students,
  employees,
  currentUser,
  selectedCentreFilter,
  globalSearch,
  loading,
  onNotify,
}) => {
  const [localSearch, setLocalSearch] = useState('');
  const [centreFilter, setCentreFilter] = useState<CentreId | 'all'>(selectedCentreFilter);
  const [tmaFilter, setTmaFilter] = useState('all');
  const [sortKey, setSortKey] = useState<SortKey>('serialNumber');
  const [sortAsc, setSortAsc] = useState(true);
  const [page, setPage] = useState(1);
  const pageSize = 20;

  const [selectedCell, setSelectedCell] = useState<{ coord: string; value: string }>({
    coord: 'A1',
    value: 'S.No — Vision Point Super Excel Master Sheet',
  });

  // Inline Excel quick-add row state
  const [showInlineRow, setShowInlineRow] = useState(false);
  const [inlineName, setInlineName] = useState('');
  const [inlineMobile, setInlineMobile] = useState('');
  const [inlineCentre, setInlineCentre] = useState<CentreId>(
    currentUser.role === 'super_admin' ? 'vp_lookerganj' : currentUser.centreId,
  );
  const [inlineTma, setInlineTma] = useState<TmaStatus>('Pending');
  const [inlinePractical, setInlinePractical] = useState<PracticalStatus>('Pending');
  const [inlineAttendance, setInlineAttendance] = useState<ClassAttendanceStatus>('Regular');
  const [inlineSaving, setInlineSaving] = useState(false);

  const [viewingStudent, setViewingStudent] = useState<Student | null>(null);
  const [editingStudent, setEditingStudent] = useState<Student | null>(null);
  const [showFormModal, setShowFormModal] = useState(false);
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [deletingStudent, setDeletingStudent] = useState<Student | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [govBusyId, setGovBusyId] = useState<string | null>(null);
  const [bulkGovBusy, setBulkGovBusy] = useState(false);

  const effectiveCentre =
    currentUser.role === 'super_admin'
      ? selectedCentreFilter !== 'all'
        ? selectedCentreFilter
        : centreFilter
      : currentUser.centreId;

  const combinedSearch = (localSearch || globalSearch).trim().toLowerCase();

  const filtered = useMemo(() => {
    return students
      .filter((s) => (effectiveCentre === 'all' ? true : s.centreId === effectiveCentre))
      .filter((s) => (tmaFilter === 'all' ? true : s.tmaStatus === tmaFilter))
      .filter((s) => {
        if (!combinedSearch) return true;
        return (
          s.studentName.toLowerCase().includes(combinedSearch) ||
          s.mobileNumber.toLowerCase().includes(combinedSearch) ||
          s.subject.toLowerCase().includes(combinedSearch) ||
          s.centreName.toLowerCase().includes(combinedSearch) ||
          String(s.serialNumber).includes(combinedSearch)
        );
      })
      .sort((a, b) => {
        const valA = a[sortKey];
        const valB = b[sortKey];
        if (typeof valA === 'number' && typeof valB === 'number') {
          return sortAsc ? valA - valB : valB - valA;
        }
        return sortAsc
          ? String(valA).localeCompare(String(valB))
          : String(valB).localeCompare(String(valA));
      });
  }, [students, effectiveCentre, tmaFilter, combinedSearch, sortKey, sortAsc]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const paginated = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  const canCreate =
    currentUser.role === 'super_admin' ||
    currentUser.role === 'centre_head' ||
    currentUser.role === 'employee';
  const canDelete = currentUser.role === 'super_admin';
  const isCentreHead = currentUser.role === 'centre_head';

  const nextSerialPreview = useMemo(() => {
    if (students.length === 0) return 1;
    return Math.max(...students.map((s) => Number(s.serialNumber || 0))) + 1;
  }, [students]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc((p) => !p);
    else {
      setSortKey(key);
      setSortAsc(true);
    }
  };

  const handleOpenInlineRow = () => {
    const defaultC =
      currentUser.role === 'super_admin'
        ? effectiveCentre === 'all'
          ? 'vp_lookerganj'
          : effectiveCentre
        : currentUser.centreId;
    setInlineCentre(defaultC);
    setInlineName('');
    setInlineMobile('');
    setInlineTma('Pending');
    setInlinePractical('Pending');
    setInlineAttendance('Regular');
    setShowInlineRow(true);
    setSelectedCell({ coord: 'B_NEW', value: 'Entering new student row directly in Excel grid...' });
  };

  const handleSaveInlineRow = async () => {
    if (inlineName.trim().length < 2) {
      onNotify('Invalid Name', 'Please enter full student name (at least 2 characters).', 'error');
      return;
    }
    if (inlineMobile.trim().length < 7) {
      onNotify('Invalid Mobile No', 'Please enter a valid mobile number.', 'error');
      return;
    }

    setInlineSaving(true);
    try {
      const targetCentre = currentUser.role === 'super_admin' ? inlineCentre : currentUser.centreId;
      const serialNumber = await getNextSerialNumber(students);
      const code = CENTRE_MAP[targetCentre].code;
      const internalId = `${code}-${new Date().getFullYear()}-${String(serialNumber).padStart(4, '0')}-${Math.random()
        .toString(36)
        .slice(2, 5)
        .toUpperCase()}`;

      const dupMsg = await checkDuplicateStudent(internalId, inlineMobile.trim(), targetCentre);
      if (dupMsg) {
        onNotify('Duplicate Entry Blocked', dupMsg, 'error');
        setInlineSaving(false);
        return;
      }

      const locCheck = await verifyOperationLocation(currentUser, `EXCEL_ADD_ROW:${internalId}`, targetCentre);
      if (!locCheck.allowed) {
        onNotify(
          'Location Verification Failed',
          locCheck.error || 'Physical presence at assigned centre is required.',
          'error',
        );
        setInlineSaving(false);
        return;
      }

      await createStudentRecord(
        {
          serialNumber,
          studentId: internalId,
          studentName: inlineName.trim(),
          mobileNumber: inlineMobile.trim(),
          subject: 'Hindi, English, Mathematics, Science, Social Science',
          tcStatus: 'Not Received',
          bookStatus: 'Pending',
          classAttendanceStatus: inlineAttendance,
          whyNios: '',
          currentEducationStatus: '',
          futurePlanning: '',
          tmaStatus: inlineTma,
          practicalStatus: inlinePractical,
          examinationStatus: 'Not Completed',
          centreId: targetCentre,
          centreName: CENTRE_MAP[targetCentre].name,
          admissionDate: new Date().toISOString().slice(0, 10),
          assignedEmployeeUid: currentUser.uid,
          assignedEmployeeName: currentUser.fullName,
          additionalRemarks:
            currentUser.role === 'employee'
              ? `Entered & locked once by ${currentUser.fullName}`
              : 'Entered via Excel Grid',
        },
        currentUser,
        true,
        { createDepartmentSkeletons: currentUser.role !== 'employee' },
      );

      onNotify(
        currentUser.role === 'employee' ? 'Row Saved & Locked' : 'Student Added to Excel',
        currentUser.role === 'employee'
          ? `${inlineName.trim()} saved at Serial #${serialNumber}. Locked for employees — only Centre Head or authorized Super Admin can edit.`
          : `${inlineName.trim()} added at Serial #${serialNumber}.`,
        'success',
      );
      setShowInlineRow(false);
      setInlineName('');
      setInlineMobile('');
    } catch (err) {
      onNotify('Excel Save Error', err instanceof Error ? err.message : 'Unable to save row.', 'error');
    } finally {
      setInlineSaving(false);
    }
  };

  const handleToggleSuperAdminAccess = async (student: Student) => {
    const nextGranted = student.superAdminAccessGranted === false;
    setGovBusyId(student.studentId);
    try {
      await toggleStudentSuperAdminAccess(student, nextGranted, currentUser);
      onNotify(
        nextGranted ? 'Super Admin Access Granted' : 'Restricted to Centre Head',
        nextGranted
          ? `Super Admin can now edit ${student.studentName}'s record.`
          : `Super Admin edit access restricted for ${student.studentName}.`,
        'success',
      );
    } catch (err) {
      onNotify('Permission Update Failed', err instanceof Error ? err.message : 'Failed to update access.', 'error');
    } finally {
      setGovBusyId(null);
    }
  };

  const handleToggleEmployeeLock = async (student: Student) => {
    const nextLocked = !student.employeeLocked;
    setGovBusyId(student.studentId);
    try {
      await toggleStudentEmployeeLock(student, nextLocked, currentUser);
      onNotify(
        nextLocked ? 'Row Locked for Employees' : 'Row Unlocked by Centre Head',
        `${student.studentName} is now ${nextLocked ? 'locked from employee edits' : 'editable once by branch employee'}.`,
        'info',
      );
    } catch (err) {
      onNotify('Lock Update Failed', err instanceof Error ? err.message : 'Failed to update row lock.', 'error');
    } finally {
      setGovBusyId(null);
    }
  };

  const handleBulkSuperAdminAccess = async (granted: boolean) => {
    const branchRows = filtered.filter((s) => s.centreId === currentUser.centreId);
    if (branchRows.length === 0) return;
    setBulkGovBusy(true);
    try {
      const count = await bulkSetStudentSuperAdminAccess(branchRows, granted, currentUser);
      onNotify(
        granted ? 'Super Admin Access Enabled' : 'Super Admin Access Restricted',
        `Updated ${count} student rows in ${CENTRE_MAP[currentUser.centreId].name}.`,
        'success',
      );
    } catch (err) {
      onNotify('Bulk Update Failed', err instanceof Error ? err.message : 'Unable to update rows.', 'error');
    } finally {
      setBulkGovBusy(false);
    }
  };

  const handleExportCsv = () => {
    exportToCsv(
      `vision-point-students-${effectiveCentre}.csv`,
      ['S.No', 'Student Name', 'Mobile No', 'Centre', 'TMA', 'Practical', 'Attendance (Live Classes)', 'Subjects', 'Admission Date'],
      filtered.map((s) => [
        s.serialNumber,
        s.studentName,
        s.mobileNumber,
        s.centreName,
        s.tmaStatus,
        s.practicalStatus,
        s.classAttendanceStatus,
        s.subject,
        s.admissionDate,
      ]),
    );
    onNotify('Export Complete', `Exported ${filtered.length} student rows to CSV.`, 'success');
  };

  const handleExportExcel = () => {
    exportToExcel(
      `vision-point-students-${effectiveCentre}.xls`,
      'Student Database',
      ['S.No', 'Student Name', 'Mobile No', 'Centre', 'TMA', 'Practical', 'Attendance (Live Classes)'],
      filtered.map((s) => [
        s.serialNumber,
        s.studentName,
        s.mobileNumber,
        s.centreName,
        s.tmaStatus,
        s.practicalStatus,
        s.classAttendanceStatus,
      ]),
    );
    onNotify('Excel Export Ready', `Exported ${filtered.length} student rows to Excel.`, 'success');
  };

  const handleConfirmDelete = async () => {
    if (!deletingStudent) return;
    setDeleteBusy(true);
    try {
      await deleteStudentRecord(
        deletingStudent.studentId,
        deletingStudent.studentName,
        deletingStudent.centreId,
        currentUser,
      );
      onNotify('Student Deleted', `Removed ${deletingStudent.studentName} (Serial #${deletingStudent.serialNumber}).`, 'info');
      setDeletingStudent(null);
    } catch (err) {
      onNotify('Delete Failed', err instanceof Error ? err.message : 'Unable to delete record.', 'error');
    } finally {
      setDeleteBusy(false);
    }
  };

  const handleTransferCentre = async (student: Student, targetCentreId: CentreId) => {
    try {
      await updateStudentRecord(
        student.studentId,
        {
          centreId: targetCentreId,
          centreName: CENTRE_MAP[targetCentreId].name,
        },
        currentUser,
        targetCentreId,
        true,
      );
      onNotify('Student Transferred', `${student.studentName} moved to ${CENTRE_MAP[targetCentreId].name}.`, 'success');
    } catch (err) {
      onNotify('Transfer Failed', err instanceof Error ? err.message : 'Failed to transfer centre.', 'error');
    }
  };

  return (
    <div className="space-y-4">
      {/* Obsidian-Crimson Translucent Glass Excel Ribbon & Action Header */}
      <div className="glass-dark-panel text-white rounded-2xl p-5">
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2.5 text-[11px] font-mono uppercase tracking-wider text-rose-200">
              <FileSpreadsheet className="w-4 h-4 text-[#FBBF24]" />
              <span>VISION_POINT_STUDENTS.xlsx</span>
              <span className="text-rose-300/40">·</span>
              <span className="text-[#FBBF24] font-bold">{filtered.length} Records</span>
            </div>
            <h2 className="text-xl font-extrabold text-white mt-1">Student Database Excel Sheet</h2>
            <p className="text-xs text-slate-200/85 mt-0.5">
              Serial-ordered Excel ledger ·{' '}
              {currentUser.role === 'employee'
                ? 'Fill-once protected: once saved, entries lock automatically and can only be corrected by your Centre Head or authorized Super Admin.'
                : currentUser.role === 'centre_head'
                  ? 'Centre Head Authority: Edit locked rows, toggle row locks, or grant/restrict Super Admin edit permissions.'
                  : 'Super Admin Oversight: Editable wherever Centre Head access is granted.'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleExportCsv}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-white/10 hover:bg-white/20 border border-white/20 rounded-xl backdrop-blur-md whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5 text-[#FBBF24]" />
              CSV
            </button>
            <button
              type="button"
              onClick={handleExportExcel}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-white/10 hover:bg-white/20 border border-white/20 rounded-xl backdrop-blur-md whitespace-nowrap"
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-300" />
              Excel (.xls)
            </button>
            {canCreate && (
              <>
                <button
                  type="button"
                  onClick={() => setShowBulkImport(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-white/10 hover:bg-white/20 border border-white/20 rounded-xl backdrop-blur-md whitespace-nowrap"
                >
                  <Upload className="w-3.5 h-3.5" />
                  Bulk Import
                </button>
                <button
                  type="button"
                  onClick={handleOpenInlineRow}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold text-white btn-crimson-gloss rounded-xl whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Fill Row in Excel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditingStudent(null);
                    setShowFormModal(true);
                  }}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-white/15 hover:bg-white/25 border border-white/25 rounded-xl whitespace-nowrap"
                >
                  Detailed Form
                </button>
              </>
            )}
          </div>
        </div>

        {/* Centre Head Super Admin Governance Strip */}
        {isCentreHead && filtered.length > 0 && (
          <div className="mt-4 pt-3.5 border-t border-sky-300/20 flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-sky-100">
              <strong className="text-[#F59E0B]">Centre Head Access Control:</strong> Grant or restrict Super Admin
              editing permission for your centre&apos;s student rows.
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={bulkGovBusy}
                onClick={() => handleBulkSuperAdminAccess(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold bg-emerald-500/25 hover:bg-emerald-500/35 text-emerald-100 border border-emerald-300/35 rounded-lg disabled:opacity-50"
              >
                <ShieldCheck className="w-3.5 h-3.5" />
                Grant Super Admin Access (All)
              </button>
              <button
                type="button"
                disabled={bulkGovBusy}
                onClick={() => handleBulkSuperAdminAccess(false)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold bg-amber-500/25 hover:bg-amber-500/35 text-amber-100 border border-amber-300/35 rounded-lg disabled:opacity-50"
              >
                <ShieldOff className="w-3.5 h-3.5" />
                Centre Head Only (Restrict All)
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Filter & Search Bar */}
      <div className="glass-light-card rounded-xl p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="relative sm:col-span-2">
          <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={localSearch}
            onChange={(e) => {
              setLocalSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search by Serial No, Student Name, Mobile No, Centre, or Subject..."
            className="w-full pl-9 pr-3.5 py-2 text-sm bg-white text-[#08152E] placeholder:text-slate-400 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0F2F6B]"
          />
        </div>

        {currentUser.role === 'super_admin' && selectedCentreFilter === 'all' && (
          <select
            value={centreFilter}
            onChange={(e) => {
              setCentreFilter(e.target.value as CentreId | 'all');
              setPage(1);
            }}
            className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white text-[#08152E] font-medium focus:outline-none focus:ring-2 focus:ring-[#0F2F6B]"
          >
            <option value="all">All 4 Centres</option>
            {CANONICAL_CENTRES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}

        <select
          value={tmaFilter}
          onChange={(e) => {
            setTmaFilter(e.target.value);
            setPage(1);
          }}
          className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white text-[#08152E] font-medium focus:outline-none focus:ring-2 focus:ring-[#0F2F6B]"
        >
          <option value="all">All TMA Statuses</option>
          <option value="Submitted">TMA Submitted</option>
          <option value="Pending">TMA Pending</option>
          <option value="Not Submitted">TMA Not Submitted</option>
        </select>
      </div>

      {/* Authentic Excel Formula Bar + Spreadsheet Grid */}
      <div className="glass-light-card rounded-xl overflow-hidden border border-slate-300">
        {/* Excel Formula / Selection Bar */}
        <div className="flex items-center border-b border-slate-300 bg-slate-50 text-xs">
          <div className="w-20 px-3 py-2 font-mono font-bold text-[#B91C1C] border-r border-slate-300 text-center bg-white">
            {selectedCell.coord}
          </div>
          <div className="px-3 py-2 font-mono font-bold text-slate-500 border-r border-slate-300 select-none">
            fx
          </div>
          <div className="flex-1 px-3 py-2 font-mono text-[#0F172A] truncate bg-white">
            {selectedCell.value}
          </div>
        </div>

        {loading ? (
          <div className="p-8 space-y-3 bg-white">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-9 bg-slate-100 rounded" />
            ))}
          </div>
        ) : paginated.length === 0 && !showInlineRow ? (
          <div className="p-12 text-center bg-white">
            <Users className="w-10 h-10 text-slate-400 mx-auto" />
            <h3 className="text-sm font-bold text-[#08152E] mt-3">No Student Rows in Sheet</h3>
            <p className="text-xs text-slate-600 mt-1 max-w-sm mx-auto">
              {combinedSearch
                ? 'No rows matched your current search criteria.'
                : 'Click "Fill Row in Excel" above to enter your first student record directly in the spreadsheet.'}
            </p>
            {canCreate && !combinedSearch && (
              <button
                type="button"
                onClick={handleOpenInlineRow}
                className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-[#08152E] bg-[#F59E0B] rounded-lg hover:bg-amber-400"
              >
                <Plus className="w-3.5 h-3.5" />
                Fill First Student Row
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto bg-white">
            <table className="excel-sheet-table">
              <thead>
                {/* Column Letters Row A..I */}
                <tr className="excel-col-letters">
                  <th className="w-16">A</th>
                  <th className="min-w-[190px]">B</th>
                  <th className="min-w-[125px]">C</th>
                  <th className="min-w-[180px]">D</th>
                  <th className="min-w-[120px]">E</th>
                  <th className="min-w-[120px]">F</th>
                  <th className="min-w-[165px]">G</th>
                  <th className="min-w-[175px]">H</th>
                  <th className="min-w-[140px]">I</th>
                </tr>

                {/* Exact Requested Excel Header Columns (NO Student ID column) */}
                <tr className="excel-col-header text-left">
                  <th>
                    <button
                      type="button"
                      onClick={() => toggleSort('serialNumber')}
                      className="inline-flex items-center gap-1 hover:text-[#F59E0B]"
                    >
                      S.No <ArrowUpDown className="w-3 h-3" />
                    </button>
                  </th>
                  <th>
                    <button
                      type="button"
                      onClick={() => toggleSort('studentName')}
                      className="inline-flex items-center gap-1 hover:text-[#F59E0B]"
                    >
                      Student Name <ArrowUpDown className="w-3 h-3" />
                    </button>
                  </th>
                  <th>Mobile No</th>
                  <th>Centre</th>
                  <th>
                    <button
                      type="button"
                      onClick={() => toggleSort('tmaStatus')}
                      className="inline-flex items-center gap-1 hover:text-[#F59E0B]"
                    >
                      TMA <ArrowUpDown className="w-3 h-3" />
                    </button>
                  </th>
                  <th>
                    <button
                      type="button"
                      onClick={() => toggleSort('practicalStatus')}
                      className="inline-flex items-center gap-1 hover:text-[#F59E0B]"
                    >
                      Practical <ArrowUpDown className="w-3 h-3" />
                    </button>
                  </th>
                  <th>
                    <button
                      type="button"
                      onClick={() => toggleSort('classAttendanceStatus')}
                      className="inline-flex items-center gap-1 hover:text-[#F59E0B]"
                    >
                      Attendance Live Classes <ArrowUpDown className="w-3 h-3" />
                    </button>
                  </th>
                  <th>Lock &amp; Access</th>
                  <th className="text-center">Actions</th>
                </tr>
              </thead>

              <tbody>
                {/* Inline Quick-Add Excel Row */}
                {showInlineRow && (
                  <tr className="bg-amber-50/90">
                    <td className="px-2.5 py-2 text-center font-mono font-bold text-[#0B2454]">
                      {nextSerialPreview}
                    </td>
                    <td className="p-1.5">
                      <input
                        type="text"
                        value={inlineName}
                        onChange={(e) => setInlineName(e.target.value)}
                        placeholder="Enter Student Name*"
                        className="w-full px-2 py-1.5 text-xs bg-white border border-[#0F2F6B] rounded text-[#08152E] focus:outline-none"
                      />
                    </td>
                    <td className="p-1.5">
                      <input
                        type="tel"
                        value={inlineMobile}
                        onChange={(e) => setInlineMobile(e.target.value)}
                        placeholder="Mobile No*"
                        className="w-full px-2 py-1.5 text-xs font-mono bg-white border border-slate-300 rounded text-[#08152E] focus:outline-none focus:border-[#0F2F6B]"
                      />
                    </td>
                    <td className="p-1.5">
                      {currentUser.role === 'super_admin' ? (
                        <select
                          value={inlineCentre}
                          onChange={(e) => setInlineCentre(e.target.value as CentreId)}
                          className="w-full px-2 py-1.5 text-xs bg-white border border-slate-300 rounded text-[#08152E]"
                        >
                          {CANONICAL_CENTRES.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="px-2 py-1 text-xs font-semibold text-[#08152E] block truncate">
                          {CENTRE_MAP[currentUser.centreId]?.name}
                        </span>
                      )}
                    </td>
                    <td className="p-1.5">
                      <select
                        value={inlineTma}
                        onChange={(e) => setInlineTma(e.target.value as TmaStatus)}
                        className="w-full px-2 py-1.5 text-xs bg-white border border-slate-300 rounded text-[#08152E]"
                      >
                        <option value="Submitted">Submitted</option>
                        <option value="Pending">Pending</option>
                        <option value="Not Submitted">Not Submitted</option>
                      </select>
                    </td>
                    <td className="p-1.5">
                      <select
                        value={inlinePractical}
                        onChange={(e) => setInlinePractical(e.target.value as PracticalStatus)}
                        className="w-full px-2 py-1.5 text-xs bg-white border border-slate-300 rounded text-[#08152E]"
                      >
                        <option value="Completed">Completed</option>
                        <option value="Pending">Pending</option>
                        <option value="Not Completed">Not Completed</option>
                      </select>
                    </td>
                    <td className="p-1.5">
                      <select
                        value={inlineAttendance}
                        onChange={(e) => setInlineAttendance(e.target.value as ClassAttendanceStatus)}
                        className="w-full px-2 py-1.5 text-xs bg-white border border-slate-300 rounded text-[#08152E]"
                      >
                        <option value="Regular">Regular</option>
                        <option value="Irregular">Irregular</option>
                        <option value="Not Attending">Not Attending</option>
                      </select>
                    </td>
                    <td className="px-2.5 py-2 text-[11px] font-semibold text-amber-800">
                      {currentUser.role === 'employee' ? 'Locks Immediately on Save' : 'New Row'}
                    </td>
                    <td className="p-1.5 text-center">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          disabled={inlineSaving}
                          onClick={handleSaveInlineRow}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-bold btn-crimson-gloss text-white rounded disabled:opacity-50"
                        >
                          <Check className="w-3.5 h-3.5" />
                          {inlineSaving ? 'Saving...' : 'Save'}
                        </button>
                        <button
                          type="button"
                          disabled={inlineSaving}
                          onClick={() => setShowInlineRow(false)}
                          className="p-1.5 text-slate-600 hover:text-[#08152E] rounded hover:bg-slate-200"
                          title="Cancel row"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                )}

                {paginated.map((s, idx) => {
                  const rowNum = (safePage - 1) * pageSize + idx + 1;
                  const canEditRow = canUserEditStudentRow(s, currentUser);
                  const saAllowed = s.superAdminAccessGranted !== false;

                  return (
                    <tr key={s.studentId} className="excel-row transition-colors">
                      {/* A: S.No */}
                      <td
                        onClick={() => setSelectedCell({ coord: `A${rowNum}`, value: String(s.serialNumber) })}
                        className="px-2.5 py-2 text-center font-mono font-bold text-[#0B2454] bg-[#F8FAFC] tabular-nums cursor-cell"
                      >
                        {s.serialNumber}
                      </td>

                      {/* B: Student Name (No Student ID shown) */}
                      <td
                        onClick={() => setSelectedCell({ coord: `B${rowNum}`, value: `${s.studentName} (${s.subject})` })}
                        className="px-3 py-2 font-semibold text-[#08152E] cursor-cell"
                      >
                        {s.studentName}
                      </td>

                      {/* C: Mobile No */}
                      <td
                        onClick={() => setSelectedCell({ coord: `C${rowNum}`, value: s.mobileNumber })}
                        className="px-3 py-2 font-mono text-[#08152E] tabular-nums cursor-cell"
                      >
                        {s.mobileNumber}
                      </td>

                      {/* D: Centre */}
                      <td
                        onClick={() => setSelectedCell({ coord: `D${rowNum}`, value: s.centreName })}
                        className="px-3 py-2 text-[#08152E] font-medium cursor-cell"
                      >
                        <span className="font-mono font-bold text-[#0B2454] mr-1.5">
                          {CENTRE_MAP[s.centreId]?.code}
                        </span>
                        <span className="text-slate-700">{s.centreName}</span>
                      </td>

                      {/* E: TMA */}
                      <td
                        onClick={() => setSelectedCell({ coord: `E${rowNum}`, value: s.tmaStatus })}
                        className={`px-3 py-2 font-bold cursor-cell ${
                          s.tmaStatus === 'Submitted'
                            ? 'bg-emerald-50/70 text-emerald-800'
                            : s.tmaStatus === 'Pending'
                              ? 'bg-amber-50/70 text-amber-800'
                              : 'bg-red-50/70 text-red-800'
                        }`}
                      >
                        {s.tmaStatus}
                      </td>

                      {/* F: Practical */}
                      <td
                        onClick={() => setSelectedCell({ coord: `F${rowNum}`, value: s.practicalStatus })}
                        className={`px-3 py-2 font-bold cursor-cell ${
                          s.practicalStatus === 'Completed'
                            ? 'bg-emerald-50/70 text-emerald-800'
                            : s.practicalStatus === 'Pending'
                              ? 'bg-amber-50/70 text-amber-800'
                              : 'bg-red-50/70 text-red-800'
                        }`}
                      >
                        {s.practicalStatus}
                      </td>

                      {/* G: Attendance Live Classes */}
                      <td
                        onClick={() => setSelectedCell({ coord: `G${rowNum}`, value: s.classAttendanceStatus })}
                        className={`px-3 py-2 font-semibold cursor-cell ${
                          s.classAttendanceStatus === 'Regular'
                            ? 'text-emerald-800'
                            : s.classAttendanceStatus === 'Irregular'
                              ? 'text-amber-800'
                              : 'text-red-800'
                        }`}
                      >
                        {s.classAttendanceStatus}
                      </td>

                      {/* H: Lock & Governance Access State */}
                      <td className="px-2.5 py-1.5">
                        <div className="flex flex-col gap-0.5 text-[11px]">
                          {s.employeeLocked ? (
                            <span className="inline-flex items-center gap-1 font-bold text-[#0B2454]">
                              <Lock className="w-3 h-3 text-[#B45309]" />
                              Locked{s.lockedByName ? ` (${s.lockedByName})` : ''}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 font-semibold text-emerald-700">
                              <Unlock className="w-3 h-3" />
                              Employee Editable
                            </span>
                          )}
                          <span className={`text-[10px] font-mono ${saAllowed ? 'text-slate-600' : 'text-red-700 font-bold'}`}>
                            {saAllowed ? 'Super Admin: Allowed' : 'Centre Head Only'}
                          </span>
                        </div>
                      </td>

                      {/* I: Actions */}
                      <td className="px-2.5 py-1.5 text-center">
                        <div className="inline-flex items-center justify-center gap-1">
                          <button
                            type="button"
                            onClick={() => setViewingStudent(s)}
                            className="p-1.5 text-slate-700 hover:text-[#08152E] hover:bg-sky-100 rounded"
                            title="View Details"
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </button>

                          {canEditRow ? (
                            <button
                              type="button"
                              onClick={() => {
                                setEditingStudent(s);
                                setShowFormModal(true);
                              }}
                              className="p-1.5 text-[#0B2454] hover:bg-sky-100 rounded"
                              title="Edit Row"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                            </button>
                          ) : (
                            <span
                              className="p-1.5 text-slate-400 cursor-not-allowed"
                              title={
                                currentUser.role === 'employee'
                                  ? 'Locked: Employees cannot re-edit once filled. Only Centre Head or authorized Super Admin can edit.'
                                  : 'Restricted by Centre Head: Super Admin edit permission disabled.'
                              }
                            >
                              <Lock className="w-3.5 h-3.5" />
                            </span>
                          )}

                          {isCentreHead && (
                            <>
                              <button
                                type="button"
                                disabled={govBusyId === s.studentId}
                                onClick={() => handleToggleSuperAdminAccess(s)}
                                className={`p-1.5 rounded ${
                                  saAllowed
                                    ? 'text-emerald-700 hover:bg-emerald-50'
                                    : 'text-amber-700 hover:bg-amber-50'
                                }`}
                                title={
                                  saAllowed
                                    ? 'Super Admin Access Granted (click to restrict to Centre Head only)'
                                    : 'Restricted to Centre Head Only (click to grant Super Admin edit access)'
                                }
                              >
                                {saAllowed ? (
                                  <ShieldCheck className="w-3.5 h-3.5" />
                                ) : (
                                  <ShieldOff className="w-3.5 h-3.5" />
                                )}
                              </button>

                              <button
                                type="button"
                                disabled={govBusyId === s.studentId}
                                onClick={() => handleToggleEmployeeLock(s)}
                                className="p-1.5 text-slate-700 hover:text-[#0B2454] hover:bg-sky-100 rounded"
                                title={
                                  s.employeeLocked
                                    ? 'Unlock Row for 1-Time Employee Correction'
                                    : 'Lock Row Against Employee Edits'
                                }
                              >
                                {s.employeeLocked ? (
                                  <Unlock className="w-3.5 h-3.5" />
                                ) : (
                                  <Lock className="w-3.5 h-3.5" />
                                )}
                              </button>
                            </>
                          )}

                          {canDelete && (
                            <button
                              type="button"
                              onClick={() => setDeletingStudent(s)}
                              className="p-1.5 text-slate-600 hover:text-red-700 hover:bg-red-50 rounded"
                              title="Delete Student"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Excel Sheet Tab Footer + Pagination */}
        <div className="px-4 py-2.5 border-t border-slate-300 bg-slate-50 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-700">
          <div className="flex items-center gap-2">
            <span className="px-3 py-1 bg-white border border-slate-300 border-b-2 border-b-[#DC2626] rounded-t font-bold text-[#B91C1C]">
              Sheet1: Student Database
            </span>
            <span className="text-[11px] font-mono text-slate-600">
              {filtered.length} total rows
            </span>
          </div>

          {filtered.length > pageSize && (
            <div className="flex items-center gap-2">
              <span>
                Page <strong className="font-mono text-[#08152E]">{safePage}</strong> of{' '}
                <strong className="font-mono text-[#08152E]">{totalPages}</strong>
              </span>
              <button
                type="button"
                disabled={safePage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-[#08152E] bg-white border border-slate-300 rounded hover:bg-slate-100 disabled:opacity-40"
              >
                <ChevronLeft className="w-3.5 h-3.5" /> Prev
              </button>
              <button
                type="button"
                disabled={safePage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-[#08152E] bg-white border border-slate-300 rounded hover:bg-slate-100 disabled:opacity-40"
              >
                Next <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Modals */}
      <StudentProfileModal
        student={viewingStudent}
        currentUser={currentUser}
        onClose={() => setViewingStudent(null)}
        onEdit={(s) => {
          setViewingStudent(null);
          setEditingStudent(s);
          setShowFormModal(true);
        }}
        onTransferCentre={currentUser.role === 'super_admin' ? handleTransferCentre : undefined}
      />

      <StudentFormModal
        open={showFormModal}
        editingStudent={editingStudent}
        currentUser={currentUser}
        defaultCentreId={effectiveCentre === 'all' ? 'vp_lookerganj' : effectiveCentre}
        existingStudents={students}
        employees={employees}
        onClose={() => setShowFormModal(false)}
        onSuccess={(msg) => onNotify('Student Excel Updated', msg, 'success')}
        onError={(title, desc) => onNotify(title, desc, 'error')}
      />

      <BulkImportModal
        open={showBulkImport}
        currentUser={currentUser}
        defaultCentreId={effectiveCentre === 'all' ? 'vp_lookerganj' : effectiveCentre}
        existingStudents={students}
        onClose={() => setShowBulkImport(false)}
        onSuccess={(msg) => onNotify('Bulk Import Finished', msg, 'success')}
        onError={(title, desc) => onNotify(title, desc, 'error')}
      />

      <ConfirmDialog
        open={Boolean(deletingStudent)}
        title="Confirm Student Deletion"
        description={`Are you sure you want to permanently delete ${deletingStudent?.studentName} (Serial #${deletingStudent?.serialNumber}) and all linked department records? This action is recorded in the audit log.`}
        confirmLabel="Delete Student"
        destructive
        busy={deleteBusy}
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeletingStudent(null)}
      />
    </div>
  );
};

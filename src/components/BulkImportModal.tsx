import { Download, FileSpreadsheet, Upload, X } from 'lucide-react';
import React, { useState } from 'react';
import { CENTRE_MAP } from '../constants/centres';
import { exportToCsv, parseCsvText } from '../lib/csvUtils';
import { verifyOperationLocation } from '../lib/securityClient';
import { checkDuplicateStudent, createStudentRecord, getNextSerialNumber } from '../services/firestoreService';
import type { CentreId, Student, UserAccount } from '../types/domain';

interface BulkImportModalProps {
  open: boolean;
  currentUser: UserAccount;
  defaultCentreId: CentreId;
  existingStudents: Student[];
  onClose: () => void;
  onSuccess: (msg: string) => void;
  onError: (title: string, desc: string) => void;
}

export const BulkImportModal: React.FC<BulkImportModalProps> = ({
  open,
  currentUser,
  defaultCentreId,
  existingStudents,
  onClose,
  onSuccess,
  onError,
}) => {
  const [parsedRows, setParsedRows] = useState<Array<Record<string, string>>>([]);
  const [fileName, setFileName] = useState('');
  const [importing, setImporting] = useState(false);

  if (!open) return null;

  const targetCentre = currentUser.role === 'super_admin' ? defaultCentreId : currentUser.centreId;

  const handleDownloadTemplate = () => {
    exportToCsv(
      'vision-point-student-import-template.csv',
      [
        'studentId',
        'studentName',
        'mobileNumber',
        'subject',
        'tcStatus',
        'bookStatus',
        'classAttendanceStatus',
        'whyNios',
        'currentEducationStatus',
        'futurePlanning',
        'tmaStatus',
        'practicalStatus',
        'examinationStatus',
        'admissionDate',
        'additionalRemarks',
      ],
      [
        [
          `${CENTRE_MAP[targetCentre].code}-2026-0101`,
          'Sample Student Name',
          '9876543210',
          'English, Mathematics, Science, Social Science, Hindi',
          'Received',
          'Received',
          'Regular',
          'Flexible schedule for competitive exam preparation',
          'Class 10 Appearing',
          'Engineering Entrance',
          'Submitted',
          'Pending',
          'Not Completed',
          new Date().toISOString().slice(0, 10),
          'Imported via CSV',
        ],
      ],
    );
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const text = await file.text();
    const rows = parseCsvText(text);
    setParsedRows(rows);
  };

  const handleImport = async () => {
    if (parsedRows.length === 0) return;
    setImporting(true);
    try {
      const loc = await verifyOperationLocation(currentUser, 'BULK_STUDENT_IMPORT', targetCentre);
      if (!loc.allowed) {
        onError('Location Verification Failed', loc.error || 'Physical presence required at assigned centre.');
        setImporting(false);
        return;
      }

      let nextSerial = await getNextSerialNumber(existingStudents);
      let importedCount = 0;
      let skippedCount = 0;

      for (const row of parsedRows) {
        const sname = (row.studentName || '').trim();
        const mobile = (row.mobileNumber || '').trim();
        if (!sname || !mobile) {
          skippedCount++;
          continue;
        }
        const rawSid = (row.studentId || '').trim();
        const sid =
          rawSid && /^[a-zA-Z0-9_-]+$/.test(rawSid)
            ? rawSid
            : `${CENTRE_MAP[targetCentre].code}-${new Date().getFullYear()}-${String(nextSerial).padStart(4, '0')}-${Math.random()
                .toString(36)
                .slice(2, 5)
                .toUpperCase()}`;

        const dup = await checkDuplicateStudent(sid, mobile, targetCentre);
        if (dup) {
          skippedCount++;
          continue;
        }
        await createStudentRecord(
          {
            serialNumber: nextSerial++,
            studentId: sid,
            studentName: sname,
            mobileNumber: mobile,
            subject: row.subject || 'General NIOS Stream',
            tcStatus: (['Received', 'Not Received', 'Not Applicable'].includes(row.tcStatus)
              ? row.tcStatus
              : 'Not Received') as Student['tcStatus'],
            bookStatus: (['Received', 'Not Received', 'Pending'].includes(row.bookStatus)
              ? row.bookStatus
              : 'Pending') as Student['bookStatus'],
            classAttendanceStatus: (['Regular', 'Irregular', 'Not Attending'].includes(row.classAttendanceStatus)
              ? row.classAttendanceStatus
              : 'Regular') as Student['classAttendanceStatus'],
            whyNios: row.whyNios || '',
            currentEducationStatus: row.currentEducationStatus || '',
            futurePlanning: row.futurePlanning || '',
            tmaStatus: (['Submitted', 'Not Submitted', 'Pending'].includes(row.tmaStatus)
              ? row.tmaStatus
              : 'Pending') as Student['tmaStatus'],
            practicalStatus: (['Completed', 'Not Completed', 'Pending'].includes(row.practicalStatus)
              ? row.practicalStatus
              : 'Pending') as Student['practicalStatus'],
            examinationStatus: (['Completed', 'Not Completed', 'Partially Completed'].includes(row.examinationStatus)
              ? row.examinationStatus
              : 'Not Completed') as Student['examinationStatus'],
            centreId: targetCentre,
            centreName: CENTRE_MAP[targetCentre].name,
            admissionDate: row.admissionDate || new Date().toISOString().slice(0, 10),
            assignedEmployeeUid: currentUser.uid,
            assignedEmployeeName: currentUser.fullName,
            additionalRemarks: row.additionalRemarks || 'Bulk CSV Import',
          },
          currentUser,
          true,
          { createDepartmentSkeletons: currentUser.role !== 'employee' },
        );
        importedCount++;
      }

      onSuccess(`Imported ${importedCount} student records (${skippedCount} skipped due to validation or duplicates).`);
      setParsedRows([]);
      setFileName('');
      onClose();
    } catch (err) {
      onError('Bulk Import Error', err instanceof Error ? err.message : 'Import failed.');
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#090d1b]/75 backdrop-blur-sm p-4">
      <div className="bg-white/95 backdrop-blur-xl rounded-2xl border border-slate-200 shadow-2xl max-w-2xl w-full overflow-hidden text-[#0F172A]">
        <div className="flex items-start justify-between gap-4 px-6 py-4 glass-dark-panel border-b border-rose-400/20 text-white">
          <div>
            <h3 className="text-lg font-bold text-white">Bulk Student CSV Import</h3>
            <p className="text-xs text-slate-200/85 mt-0.5">
              Target Branch: <strong className="text-[#FBBF24]">{CENTRE_MAP[targetCentre].name}</strong> · Automatic duplicate filtering
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-200 hover:text-white p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 p-3.5 rounded-xl bg-slate-50 border border-slate-200">
            <div className="flex items-center gap-2.5 text-xs text-slate-700">
              <FileSpreadsheet className="w-4 h-4 text-[#B45309]" />
              <span>Download the formatted CSV template before uploading batch records.</span>
            </div>
            <button
              type="button"
              onClick={handleDownloadTemplate}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#08152E] bg-white border border-slate-300 rounded-lg hover:bg-slate-100"
            >
              <Download className="w-3.5 h-3.5" />
              CSV Template
            </button>
          </div>

          <label className="flex flex-col items-center justify-center border-2 border-dashed border-slate-300 rounded-xl p-6 cursor-pointer hover:border-[#DC2626] hover:bg-rose-50/30 transition-colors">
            <Upload className="w-6 h-6 text-[#DC2626] mb-2" />
            <span className="text-sm font-semibold text-[#08152E]">
              {fileName ? `Selected: ${fileName}` : 'Choose a CSV file (.csv)'}
            </span>
            <span className="text-xs text-slate-600 mt-1">
              {parsedRows.length > 0 ? `${parsedRows.length} rows ready for validation` : 'UTF-8 CSV format'}
            </span>
            <input type="file" accept=".csv,text/csv" onChange={handleFileChange} className="hidden" />
          </label>

          <div className="pt-2 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={importing}
              className="px-4 py-2 text-xs font-semibold text-[#08152E] bg-white border border-slate-300 rounded-lg hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={importing || parsedRows.length === 0}
              onClick={handleImport}
              className="px-4 py-2 text-xs font-bold text-white btn-crimson-gloss rounded-lg disabled:opacity-50"
            >
              {importing ? 'Verifying & Importing...' : `Import ${parsedRows.length} Records`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

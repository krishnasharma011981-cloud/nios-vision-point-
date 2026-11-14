import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { CANONICAL_CENTRES, CENTRE_MAP } from '../constants/centres';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import type {
  ActivityLog,
  AdmissionRecord,
  Centre,
  CentreId,
  EmployeeReport,
  EmployeeReportStatus,
  FeeRecoveryRecord,
  HrRecord,
  LocationVerification,
  NotificationItem,
  OnlineClassRecord,
  PracticalRecord,
  StaffInvite,
  Student,
  SystemSettings,
  TmaRecord,
  UserAccount,
  UserDepartment,
  UserRole,
} from '../types/domain';

export async function logActivity(entry: Omit<ActivityLog, 'createdAt' | 'id'>): Promise<void> {
  const path = 'activity_logs';
  try {
    await addDoc(collection(db, path), {
      ...entry,
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function createNotification(entry: Omit<NotificationItem, 'createdAt' | 'id'>): Promise<void> {
  const path = 'notifications';
  try {
    await addDoc(collection(db, path), {
      ...entry,
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function markNotificationRead(id: string): Promise<void> {
  const path = `notifications/${id}`;
  try {
    await updateDoc(doc(db, 'notifications', id), { read: true });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function getUserProfile(uid: string): Promise<UserAccount | null> {
  const path = `users/${uid}`;
  try {
    const snap = await getDoc(doc(db, 'users', uid));
    return snap.exists() ? (snap.data() as UserAccount) : null;
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, path);
  }
}

export async function ensureInitialPlatformSetup(params: {
  uid: string;
  email: string;
  fullName: string;
  mobileNumber?: string;
}): Promise<UserAccount> {
  const { uid, email, fullName, mobileNumber = '' } = params;
  const lookerganj = CENTRE_MAP.vp_lookerganj;

  // 1. Create or confirm Super Admin user document
  const userRef = doc(db, 'users', uid);
  const existingUser = await getDoc(userRef).catch((e) =>
    handleFirestoreError(e, OperationType.GET, `users/${uid}`),
  );

  let profile: UserAccount;
  if (!existingUser.exists()) {
    const newProfile = {
      uid,
      fullName: fullName.slice(0, 100),
      email: email.slice(0, 160),
      mobileNumber: mobileNumber.slice(0, 20),
      role: 'super_admin' as UserRole,
      centreId: 'vp_lookerganj' as CentreId,
      centreName: lookerganj.name,
      department: 'all' as UserDepartment,
      status: 'Active' as const,
      joiningDate: new Date().toISOString().slice(0, 10),
      createdBy: uid,
      createdAt: serverTimestamp(),
      updatedBy: uid,
      updatedAt: serverTimestamp(),
    };
    try {
      await setDoc(userRef, newProfile);
    } catch (e) {
      handleFirestoreError(e, OperationType.CREATE, `users/${uid}`);
    }
    profile = newProfile as unknown as UserAccount;
  } else {
    profile = existingUser.data() as UserAccount;
  }

  // 2. Initialize or synchronize all 4 canonical centres (e.g. XIS -> Axis Academy rename)
  for (const c of CANONICAL_CENTRES) {
    const cRef = doc(db, 'centres', c.id);
    const cSnap = await getDoc(cRef).catch(() => null);
    if (!cSnap || !cSnap.exists()) {
      try {
        await setDoc(cRef, {
          ...c,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          updatedBy: uid,
        });
      } catch (e) {
        handleFirestoreError(e, OperationType.CREATE, `centres/${c.id}`);
      }
    } else {
      const existingData = cSnap.data() as Centre;
      if (existingData.name !== c.name || existingData.code !== c.code) {
        await updateDoc(cRef, {
          name: c.name,
          code: c.code,
          updatedAt: serverTimestamp(),
          updatedBy: uid,
        }).catch(() => {});
      }
    }
  }

  // 3. Initialize global system settings if absent
  const settingsRef = doc(db, 'system_settings', 'global');
  const settingsSnap = await getDoc(settingsRef).catch(() => null);
  if (!settingsSnap || !settingsSnap.exists()) {
    try {
      await setDoc(settingsRef, {
        superAdminEmail: email,
        superAdminUid: uid,
        geofenceEnabled: true,
        emergencyOverrideActive: false,
        sessionTimeoutMinutes: 60,
        maxGpsAccuracyMeters: 500,
        updatedAt: serverTimestamp(),
        updatedBy: uid,
      });
    } catch (e) {
      handleFirestoreError(e, OperationType.CREATE, 'system_settings/global');
    }
  }

  await logActivity({
    actorUid: uid,
    actorName: profile.fullName,
    actorEmail: email,
    actorRole: 'super_admin',
    centreId: 'vp_lookerganj',
    department: 'all',
    action: 'INITIAL_SUPER_ADMIN_SETUP',
    targetCollection: 'system_settings',
    targetId: 'global',
    details: `Super Admin initialized platform and verified 4 branch centres.`,
    locationVerified: true,
  });

  return profile;
}

export async function updateCentreConfig(
  centreId: CentreId,
  updates: Partial<Pick<Centre, 'address' | 'latitude' | 'longitude' | 'geofenceRadiusMeters' | 'status' | 'headUid' | 'headName'>>,
  actor: UserAccount,
): Promise<void> {
  const path = `centres/${centreId}`;
  try {
    await updateDoc(doc(db, 'centres', centreId), {
      ...updates,
      updatedAt: serverTimestamp(),
      updatedBy: actor.uid,
    });
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId,
      department: actor.department,
      action: 'CENTRE_UPDATED',
      targetCollection: 'centres',
      targetId: centreId,
      details: `Updated centre configuration (${Object.keys(updates).join(', ')}).`,
      locationVerified: true,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function assignCentreHead(
  centreId: CentreId,
  headUser: UserAccount,
  actor: UserAccount,
): Promise<void> {
  const centreInfo = CENTRE_MAP[centreId];
  const batch = writeBatch(db);

  // Update target user's role & centre
  batch.update(doc(db, 'users', headUser.uid), {
    role: 'centre_head',
    centreId,
    centreName: centreInfo.name,
    department: 'all',
    updatedBy: actor.uid,
    updatedAt: serverTimestamp(),
  });

  // Update centre head fields
  batch.update(doc(db, 'centres', centreId), {
    headUid: headUser.uid,
    headName: headUser.fullName,
    updatedBy: actor.uid,
    updatedAt: serverTimestamp(),
  });

  // Record assignment doc (preserve createdAt if updating an existing centre assignment)
  const centreAssignRef = doc(db, 'centre_assignments', centreId);
  const existingCentreAssign = await getDoc(centreAssignRef).catch(() => null);
  if (existingCentreAssign && existingCentreAssign.exists()) {
    batch.update(centreAssignRef, {
      centreName: centreInfo.name,
      headUid: headUser.uid,
      headName: headUser.fullName,
      headEmail: headUser.email,
      assignedBy: actor.uid,
      updatedAt: serverTimestamp(),
    });
  } else {
    batch.set(centreAssignRef, {
      centreId,
      centreName: centreInfo.name,
      headUid: headUser.uid,
      headName: headUser.fullName,
      headEmail: headUser.email,
      assignedBy: actor.uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  try {
    await batch.commit();
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId,
      department: 'all',
      action: 'CENTRE_HEAD_ASSIGNED',
      targetCollection: 'centre_assignments',
      targetId: centreId,
      details: `Assigned ${headUser.fullName} (${headUser.email}) as Centre Head of ${centreInfo.name}.`,
      locationVerified: true,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `centre_assignments/${centreId}`);
  }
}

export async function saveUserAccountDoc(
  userData: Omit<UserAccount, 'createdAt' | 'updatedAt'>,
  actor: UserAccount,
): Promise<void> {
  const path = `users/${userData.uid}`;
  try {
    await setDoc(doc(db, 'users', userData.uid), {
      ...userData,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    if (userData.role === 'employee' && userData.department !== 'all') {
      await setDoc(doc(db, 'employee_assignments', userData.uid), {
        uid: userData.uid,
        employeeName: userData.fullName,
        centreId: userData.centreId,
        department: userData.department,
        assignedBy: actor.uid,
        status: userData.status,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
    if (userData.role === 'centre_head') {
      await assignCentreHead(userData.centreId, userData as UserAccount, actor);
    }
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: userData.centreId,
      department: userData.department,
      action: 'USER_CREATED',
      targetCollection: 'users',
      targetId: userData.uid,
      details: `Created ${userData.role} account for ${userData.fullName} (${userData.email}) in ${userData.department}.`,
      locationVerified: true,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function updateUserAccount(
  uid: string,
  updates: Partial<Pick<UserAccount, 'fullName' | 'mobileNumber' | 'department' | 'status' | 'role' | 'centreId' | 'centreName'>>,
  actor: UserAccount,
  targetCentreId: string,
): Promise<void> {
  const path = `users/${uid}`;
  try {
    await updateDoc(doc(db, 'users', uid), {
      ...updates,
      updatedBy: actor.uid,
      updatedAt: serverTimestamp(),
    });
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: targetCentreId,
      department: updates.department || actor.department,
      action: 'USER_UPDATED',
      targetCollection: 'users',
      targetId: uid,
      details: `Updated user account (${Object.keys(updates).join(', ')}).`,
      locationVerified: true,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function updateSystemSettings(
  updates: Partial<Omit<SystemSettings, 'updatedAt' | 'updatedBy'>>,
  actor: UserAccount,
): Promise<void> {
  const path = 'system_settings/global';
  try {
    await updateDoc(doc(db, 'system_settings', 'global'), {
      ...updates,
      updatedAt: serverTimestamp(),
      updatedBy: actor.uid,
    });
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: actor.centreId,
      department: 'all',
      action: 'SYSTEM_SETTINGS_UPDATED',
      targetCollection: 'system_settings',
      targetId: 'global',
      details: `Updated global security settings (${Object.keys(updates).join(', ')}).`,
      locationVerified: true,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function checkDuplicateStudent(studentId: string, mobileNumber: string, centreId: CentreId): Promise<string | null> {
  const cleanId = studentId.trim();
  const idSnap = await getDoc(doc(db, 'students', cleanId)).catch(() => null);
  if (idSnap && idSnap.exists()) {
    return `A student with Student ID "${cleanId}" already exists.`;
  }
  const cleanMobile = mobileNumber.trim();
  if (cleanMobile.length >= 7) {
    const q = query(
      collection(db, 'students'),
      where('centreId', '==', centreId),
      where('mobileNumber', '==', cleanMobile),
    );
    const snap = await getDocs(q).catch(() => null);
    if (snap && !snap.empty) {
      const existing = snap.docs[0].data() as Student;
      return `Potential duplicate detected: ${existing.studentName} (${existing.studentId}) already uses mobile number ${cleanMobile} in this centre.`;
    }
  }
  return null;
}

export async function getNextSerialNumber(existingStudents: Student[]): Promise<number> {
  if (existingStudents.length === 0) return 1;
  return Math.max(...existingStudents.map((s) => Number(s.serialNumber || 0))) + 1;
}

export async function createStudentRecord(
  studentInput: Omit<Student, 'createdBy' | 'createdAt' | 'updatedBy' | 'updatedAt'>,
  actor: UserAccount,
  locationVerified: boolean,
  options?: {
    totalFee?: number;
    paidAmount?: number;
    stream?: string;
    createDepartmentSkeletons?: boolean;
  },
): Promise<void> {
  const sid = studentInput.studentId.trim();
  const path = `students/${sid}`;

  try {
    const isEmployeeActor = actor.role === 'employee';
    await setDoc(doc(db, 'students', sid), {
      ...studentInput,
      studentId: sid,
      employeeLocked: isEmployeeActor ? true : Boolean(studentInput.employeeLocked ?? false),
      lockedByUid: isEmployeeActor ? actor.uid : (studentInput.lockedByUid ?? ''),
      lockedByName: isEmployeeActor ? actor.fullName.slice(0, 100) : (studentInput.lockedByName ?? ''),
      superAdminAccessGranted: studentInput.superAdminAccessGranted ?? true,
      createdBy: actor.uid,
      createdAt: serverTimestamp(),
      updatedBy: actor.uid,
      updatedAt: serverTimestamp(),
    });

    // If Super Admin, Centre Head, or Admission Employee, initialize admission record;
    // Super Admin and Centre Head can also initialize linked department records.
    if (actor.role === 'super_admin' || actor.role === 'centre_head' || actor.department === 'admission') {
      await setDoc(doc(db, 'admission_records', sid), {
        studentId: sid,
        studentName: studentInput.studentName,
        centreId: studentInput.centreId,
        admissionStatus: 'Confirmed',
        stream: options?.stream || studentInput.subject.slice(0, 80),
        niosPurpose: studentInput.whyNios,
        academicBackground: studentInput.currentEducationStatus,
        followUpStatus: 'Completed',
        assignedEmployeeUid: studentInput.assignedEmployeeUid,
        assignedEmployeeName: studentInput.assignedEmployeeName,
        remarks: studentInput.additionalRemarks,
        admissionDate: studentInput.admissionDate,
        createdBy: actor.uid,
        createdAt: serverTimestamp(),
        updatedBy: actor.uid,
        updatedAt: serverTimestamp(),
      });
    }

    if (options?.createDepartmentSkeletons && (actor.role === 'super_admin' || actor.role === 'centre_head')) {
      const totalFee = options.totalFee ?? 12000;
      const paidAmount = options.paidAmount ?? 6000;
      const pendingAmount = Math.max(0, totalFee - paidAmount);
      const batch = writeBatch(db);
      batch.set(doc(db, 'fee_recovery', sid), {
        studentId: sid,
        studentName: studentInput.studentName,
        mobileNumber: studentInput.mobileNumber,
        centreId: studentInput.centreId,
        recoveryStatus: pendingAmount === 0 ? 'Paid' : paidAmount > 0 ? 'Partial' : 'Pending',
        followUpStatus: pendingAmount === 0 ? 'Closed' : 'Scheduled',
        totalFee,
        paidAmount,
        pendingAmount,
        assignedEmployeeUid: studentInput.assignedEmployeeUid,
        assignedEmployeeName: studentInput.assignedEmployeeName,
        followUpNotes: 'Initial fee schedule created on admission.',
        lastContactDate: studentInput.admissionDate,
        nextFollowUpDate: studentInput.admissionDate,
        createdBy: actor.uid,
        createdAt: serverTimestamp(),
        updatedBy: actor.uid,
        updatedAt: serverTimestamp(),
      });
      batch.set(doc(db, 'practical_records', sid), {
        studentId: sid,
        studentName: studentInput.studentName,
        centreId: studentInput.centreId,
        practicalStatus: studentInput.practicalStatus,
        submissionStatus: studentInput.practicalStatus === 'Completed' ? 'Submitted' : 'Not Submitted',
        completionPercentage: studentInput.practicalStatus === 'Completed' ? 100 : 0,
        assignedEmployeeUid: studentInput.assignedEmployeeUid,
        assignedEmployeeName: studentInput.assignedEmployeeName,
        remarks: '',
        createdBy: actor.uid,
        createdAt: serverTimestamp(),
        updatedBy: actor.uid,
        updatedAt: serverTimestamp(),
      });
      batch.set(doc(db, 'tma_records', sid), {
        studentId: sid,
        studentName: studentInput.studentName,
        centreId: studentInput.centreId,
        tmaStatus: studentInput.tmaStatus,
        subjectsSubmittedCount: studentInput.tmaStatus === 'Submitted' ? 5 : 0,
        totalSubjectsCount: 5,
        submissionDate: studentInput.tmaStatus === 'Submitted' ? studentInput.admissionDate : '',
        assignedEmployeeUid: studentInput.assignedEmployeeUid,
        assignedEmployeeName: studentInput.assignedEmployeeName,
        remarks: '',
        createdBy: actor.uid,
        createdAt: serverTimestamp(),
        updatedBy: actor.uid,
        updatedAt: serverTimestamp(),
      });
      batch.set(doc(db, 'online_class_records', sid), {
        studentId: sid,
        studentName: studentInput.studentName,
        centreId: studentInput.centreId,
        attendanceStatus: studentInput.classAttendanceStatus,
        participationLevel: studentInput.classAttendanceStatus === 'Regular' ? 'High' : 'Moderate',
        attendancePercentage: studentInput.classAttendanceStatus === 'Regular' ? 90 : 50,
        lastAttendanceUpdate: studentInput.admissionDate,
        followUpNotes: '',
        assignedEmployeeUid: studentInput.assignedEmployeeUid,
        assignedEmployeeName: studentInput.assignedEmployeeName,
        createdBy: actor.uid,
        createdAt: serverTimestamp(),
        updatedBy: actor.uid,
        updatedAt: serverTimestamp(),
      });
      await batch.commit();
    }

    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: studentInput.centreId,
      department: actor.department,
      action: 'STUDENT_CREATED',
      targetCollection: 'students',
      targetId: sid,
      details: `Registered student ${studentInput.studentName} (${sid}) in ${studentInput.centreName}.`,
      locationVerified,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function updateStudentRecord(
  studentId: string,
  updates: Partial<Student>,
  actor: UserAccount,
  centreId: string,
  locationVerified: boolean,
): Promise<void> {
  const path = `students/${studentId}`;
  try {
    const lockFields =
      actor.role === 'employee'
        ? {
            employeeLocked: true,
            lockedByUid: actor.uid,
            lockedByName: actor.fullName.slice(0, 100),
          }
        : {};
    await updateDoc(doc(db, 'students', studentId), {
      ...updates,
      ...lockFields,
      updatedBy: actor.uid,
      updatedAt: serverTimestamp(),
    });
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId,
      department: actor.department,
      action: updates.centreId ? 'STUDENT_TRANSFERRED' : 'STUDENT_UPDATED',
      targetCollection: 'students',
      targetId: studentId,
      details: `Updated student ${studentId} (${Object.keys(updates).join(', ')}).`,
      locationVerified,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function toggleStudentSuperAdminAccess(
  student: Student,
  granted: boolean,
  actor: UserAccount,
): Promise<void> {
  const path = `students/${student.studentId}`;
  try {
    await updateDoc(doc(db, 'students', student.studentId), {
      superAdminAccessGranted: granted,
      updatedBy: actor.uid,
      updatedAt: serverTimestamp(),
    });
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: student.centreId,
      department: 'all',
      action: granted ? 'STUDENT_SUPER_ADMIN_GRANTED' : 'STUDENT_SUPER_ADMIN_RESTRICTED',
      targetCollection: 'students',
      targetId: student.studentId,
      details: `${actor.fullName} ${granted ? 'granted' : 'restricted'} Super Admin edit access for ${student.studentName}.`,
      locationVerified: true,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function toggleStudentEmployeeLock(
  student: Student,
  locked: boolean,
  actor: UserAccount,
): Promise<void> {
  const path = `students/${student.studentId}`;
  try {
    await updateDoc(doc(db, 'students', student.studentId), {
      employeeLocked: locked,
      lockedByUid: locked ? (student.lockedByUid || actor.uid) : '',
      lockedByName: locked ? (student.lockedByName || actor.fullName.slice(0, 100)) : '',
      updatedBy: actor.uid,
      updatedAt: serverTimestamp(),
    });
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: student.centreId,
      department: 'all',
      action: locked ? 'STUDENT_ROW_LOCKED' : 'STUDENT_ROW_UNLOCKED',
      targetCollection: 'students',
      targetId: student.studentId,
      details: `${actor.fullName} ${locked ? 'locked' : 'unlocked'} row for ${student.studentName}.`,
      locationVerified: true,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function bulkSetStudentSuperAdminAccess(
  targetStudents: Student[],
  granted: boolean,
  actor: UserAccount,
): Promise<number> {
  if (targetStudents.length === 0) return 0;
  try {
    const chunkSize = 400;
    let updatedCount = 0;
    for (let i = 0; i < targetStudents.length; i += chunkSize) {
      const slice = targetStudents.slice(i, i + chunkSize);
      const batch = writeBatch(db);
      for (const s of slice) {
        batch.update(doc(db, 'students', s.studentId), {
          superAdminAccessGranted: granted,
          updatedBy: actor.uid,
          updatedAt: serverTimestamp(),
        });
        updatedCount++;
      }
      await batch.commit();
    }
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: actor.centreId,
      department: 'all',
      action: granted ? 'BULK_SUPER_ADMIN_ACCESS_GRANTED' : 'BULK_SUPER_ADMIN_ACCESS_RESTRICTED',
      targetCollection: 'students',
      targetId: actor.centreId,
      details: `${actor.fullName} ${granted ? 'granted' : 'restricted'} Super Admin edit access on ${updatedCount} branch student records.`,
      locationVerified: true,
    });
    return updatedCount;
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'students');
  }
}

export async function deleteStudentRecord(
  studentId: string,
  studentName: string,
  centreId: string,
  actor: UserAccount,
): Promise<void> {
  const path = `students/${studentId}`;
  try {
    await deleteDoc(doc(db, 'students', studentId));
    // Clean up department records if Super Admin
    const deptCols = ['fee_recovery', 'practical_records', 'tma_records', 'online_class_records', 'admission_records'];
    for (const colName of deptCols) {
      await deleteDoc(doc(db, colName, studentId)).catch(() => {});
    }
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId,
      department: 'all',
      action: 'STUDENT_DELETED',
      targetCollection: 'students',
      targetId: studentId,
      details: `Deleted student ${studentName} (${studentId}) and linked department records.`,
      locationVerified: true,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

export async function upsertFeeRecoveryRecord(
  record: Omit<FeeRecoveryRecord, 'createdBy' | 'createdAt' | 'updatedBy' | 'updatedAt'>,
  actor: UserAccount,
  locationVerified: boolean,
): Promise<void> {
  const path = `fee_recovery/${record.studentId}`;
  try {
    const ref = doc(db, 'fee_recovery', record.studentId);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      await updateDoc(ref, {
        ...record,
        updatedBy: actor.uid,
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(ref, {
        ...record,
        createdBy: actor.uid,
        createdAt: serverTimestamp(),
        updatedBy: actor.uid,
        updatedAt: serverTimestamp(),
      });
    }
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: record.centreId,
      department: 'fee_recovery',
      action: 'FEE_RECOVERY_UPDATED',
      targetCollection: 'fee_recovery',
      targetId: record.studentId,
      details: `Updated Fee Recovery for ${record.studentName}: ${record.recoveryStatus} (Pending ₹${record.pendingAmount}).`,
      locationVerified,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function upsertPracticalRecord(
  record: Omit<PracticalRecord, 'createdBy' | 'createdAt' | 'updatedBy' | 'updatedAt'>,
  actor: UserAccount,
  locationVerified: boolean,
): Promise<void> {
  const path = `practical_records/${record.studentId}`;
  try {
    const ref = doc(db, 'practical_records', record.studentId);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      await updateDoc(ref, {
        ...record,
        updatedBy: actor.uid,
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(ref, {
        ...record,
        createdBy: actor.uid,
        createdAt: serverTimestamp(),
        updatedBy: actor.uid,
        updatedAt: serverTimestamp(),
      });
    }
    // Sync central student practicalStatus when permitted (employees cannot modify locked rows)
    await updateDoc(doc(db, 'students', record.studentId), {
      practicalStatus: record.practicalStatus,
      updatedBy: actor.uid,
      updatedAt: serverTimestamp(),
    }).catch(() => {});
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: record.centreId,
      department: 'practical',
      action: 'PRACTICAL_UPDATED',
      targetCollection: 'practical_records',
      targetId: record.studentId,
      details: `Updated Practical for ${record.studentName}: ${record.practicalStatus} (${record.completionPercentage}%).`,
      locationVerified,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function upsertTmaRecord(
  record: Omit<TmaRecord, 'createdBy' | 'createdAt' | 'updatedBy' | 'updatedAt'>,
  actor: UserAccount,
  locationVerified: boolean,
): Promise<void> {
  const path = `tma_records/${record.studentId}`;
  try {
    const ref = doc(db, 'tma_records', record.studentId);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      await updateDoc(ref, {
        ...record,
        updatedBy: actor.uid,
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(ref, {
        ...record,
        createdBy: actor.uid,
        createdAt: serverTimestamp(),
        updatedBy: actor.uid,
        updatedAt: serverTimestamp(),
      });
    }
    await updateDoc(doc(db, 'students', record.studentId), {
      tmaStatus: record.tmaStatus,
      updatedBy: actor.uid,
      updatedAt: serverTimestamp(),
    }).catch(() => {});
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: record.centreId,
      department: 'tma',
      action: 'TMA_UPDATED',
      targetCollection: 'tma_records',
      targetId: record.studentId,
      details: `Updated TMA for ${record.studentName}: ${record.tmaStatus} (${record.subjectsSubmittedCount}/${record.totalSubjectsCount}).`,
      locationVerified,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function upsertOnlineClassRecord(
  record: Omit<OnlineClassRecord, 'createdBy' | 'createdAt' | 'updatedBy' | 'updatedAt'>,
  actor: UserAccount,
  locationVerified: boolean,
): Promise<void> {
  const path = `online_class_records/${record.studentId}`;
  try {
    const ref = doc(db, 'online_class_records', record.studentId);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      await updateDoc(ref, {
        ...record,
        updatedBy: actor.uid,
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(ref, {
        ...record,
        createdBy: actor.uid,
        createdAt: serverTimestamp(),
        updatedBy: actor.uid,
        updatedAt: serverTimestamp(),
      });
    }
    await updateDoc(doc(db, 'students', record.studentId), {
      classAttendanceStatus: record.attendanceStatus,
      updatedBy: actor.uid,
      updatedAt: serverTimestamp(),
    }).catch(() => {});
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: record.centreId,
      department: 'online_classes',
      action: 'ONLINE_CLASS_UPDATED',
      targetCollection: 'online_class_records',
      targetId: record.studentId,
      details: `Updated Online Class Attendance for ${record.studentName}: ${record.attendanceStatus} (${record.attendancePercentage}%).`,
      locationVerified,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function upsertAdmissionRecord(
  record: Omit<AdmissionRecord, 'createdBy' | 'createdAt' | 'updatedBy' | 'updatedAt'>,
  actor: UserAccount,
  locationVerified: boolean,
): Promise<void> {
  const path = `admission_records/${record.studentId}`;
  try {
    const ref = doc(db, 'admission_records', record.studentId);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      await updateDoc(ref, {
        ...record,
        updatedBy: actor.uid,
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(ref, {
        ...record,
        createdBy: actor.uid,
        createdAt: serverTimestamp(),
        updatedBy: actor.uid,
        updatedAt: serverTimestamp(),
      });
    }
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: record.centreId,
      department: 'admission',
      action: 'ADMISSION_RECORD_UPDATED',
      targetCollection: 'admission_records',
      targetId: record.studentId,
      details: `Updated Admission record for ${record.studentName}: ${record.admissionStatus} (${record.followUpStatus}).`,
      locationVerified,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function fetchLocationVerifications(user: UserAccount): Promise<LocationVerification[]> {
  const path = 'location_verifications';
  try {
    const q =
      user.role === 'super_admin'
        ? query(collection(db, path), orderBy('createdAt', 'desc'))
        : user.role === 'centre_head'
          ? query(collection(db, path), where('centreId', '==', user.centreId), orderBy('createdAt', 'desc'))
          : query(collection(db, path), where('uid', '==', user.uid), orderBy('createdAt', 'desc'));
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, ...(d.data() as LocationVerification) }));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function emailToInviteId(email: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const data = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `inv_${hex.slice(0, 40)}`;
}

export async function createStaffInvite(
  params: {
    fullName: string;
    email: string;
    mobileNumber: string;
    role: 'centre_head' | 'employee';
    centreId: CentreId;
    department: UserDepartment;
    joiningDate: string;
  },
  actor: UserAccount,
): Promise<StaffInvite> {
  const cleanEmail = params.email.trim().toLowerCase();
  const inviteId = await emailToInviteId(cleanEmail);
  const centreName = CENTRE_MAP[params.centreId].name;
  const inviteDoc = {
    inviteId,
    fullName: params.fullName.trim().slice(0, 100),
    email: cleanEmail.slice(0, 160),
    mobileNumber: params.mobileNumber.trim().slice(0, 20),
    role: params.role,
    centreId: params.centreId,
    centreName,
    department: params.role === 'employee' ? (params.department === 'all' ? 'admission' : params.department) : 'all',
    joiningDate: params.joiningDate,
    status: 'Pending' as const,
    claimedUid: '',
    invitedBy: actor.uid,
    invitedByName: actor.fullName.slice(0, 100),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  try {
    const invRef = doc(db, 'staff_invites', inviteId);
    const existingSnap = await getDoc(invRef).catch(() => null);
    if (existingSnap && existingSnap.exists()) {
      await updateDoc(invRef, {
        fullName: inviteDoc.fullName,
        mobileNumber: inviteDoc.mobileNumber,
        role: inviteDoc.role,
        centreId: inviteDoc.centreId,
        centreName: inviteDoc.centreName,
        department: inviteDoc.department,
        joiningDate: inviteDoc.joiningDate,
        status: 'Pending',
        claimedUid: '',
        invitedBy: inviteDoc.invitedBy,
        invitedByName: inviteDoc.invitedByName,
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(invRef, inviteDoc);
    }
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: params.centreId,
      department: inviteDoc.department,
      action: 'STAFF_INVITE_CREATED',
      targetCollection: 'staff_invites',
      targetId: inviteId,
      details: `Pre-authorized ${params.role} (${params.fullName.trim()} · ${cleanEmail}) for ${centreName} via Google Sign-In.`,
      locationVerified: true,
    });
    return inviteDoc as unknown as StaffInvite;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `staff_invites/${inviteId}`);
  }
}

export async function deleteStaffInvite(
  inviteId: string,
  email: string,
  centreId: CentreId,
  actor: UserAccount,
): Promise<void> {
  const path = `staff_invites/${inviteId}`;
  try {
    await deleteDoc(doc(db, 'staff_invites', inviteId));
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId,
      department: 'all',
      action: 'STAFF_INVITE_REVOKED',
      targetCollection: 'staff_invites',
      targetId: inviteId,
      details: `Revoked pre-authorized staff invitation for ${email}.`,
      locationVerified: true,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

const inFlightInviteClaims = new Map<string, Promise<UserAccount | null>>();

export function claimPendingStaffInvite(authUser: {
  uid: string;
  email: string;
  displayName?: string | null;
}): Promise<UserAccount | null> {
  const existingPromise = inFlightInviteClaims.get(authUser.uid);
  if (existingPromise) {
    return existingPromise;
  }

  const run = (async (): Promise<UserAccount | null> => {
    const existingProfile = await getUserProfile(authUser.uid).catch(() => null);
    if (existingProfile) return existingProfile;

    const cleanEmail = authUser.email.trim().toLowerCase();
    const inviteId = await emailToInviteId(cleanEmail);
    const inviteRef = doc(db, 'staff_invites', inviteId);
    let snap;
    try {
      snap = await getDoc(inviteRef);
    } catch {
      return null;
    }
    if (!snap.exists()) return null;

    const invite = snap.data() as StaffInvite;
    if (invite.status !== 'Pending') {
      return await getUserProfile(authUser.uid).catch(() => null);
    }

    const centreInfo = CENTRE_MAP[invite.centreId];
    const fullName = invite.fullName || authUser.displayName || cleanEmail.split('@')[0];

    const userProfile = {
      uid: authUser.uid,
      fullName: fullName.slice(0, 100),
      email: cleanEmail.slice(0, 160),
      mobileNumber: (invite.mobileNumber || '').slice(0, 20),
      role: invite.role as UserRole,
      centreId: invite.centreId,
      centreName: centreInfo.name,
      department: invite.department,
      status: 'Active' as const,
      joiningDate: invite.joiningDate || new Date().toISOString().slice(0, 10),
      createdBy: inviteId,
      createdAt: serverTimestamp(),
      updatedBy: authUser.uid,
      updatedAt: serverTimestamp(),
    };

    const batch = writeBatch(db);
    batch.set(doc(db, 'users', authUser.uid), userProfile);
    batch.update(inviteRef, {
      status: 'Claimed',
      claimedUid: authUser.uid,
      updatedAt: serverTimestamp(),
    });

    if (invite.role === 'employee' && invite.department !== 'all') {
      batch.set(doc(db, 'employee_assignments', authUser.uid), {
        uid: authUser.uid,
        employeeName: fullName.slice(0, 100),
        centreId: invite.centreId,
        department: invite.department,
        assignedBy: invite.invitedBy,
        status: 'Active',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else if (invite.role === 'centre_head') {
      batch.update(doc(db, 'centres', invite.centreId), {
        headUid: authUser.uid,
        headName: fullName.slice(0, 100),
        updatedBy: authUser.uid,
        updatedAt: serverTimestamp(),
      });

      const centreAssignRef = doc(db, 'centre_assignments', invite.centreId);
      const existingAssign = await getDoc(centreAssignRef).catch(() => null);
      if (existingAssign && existingAssign.exists()) {
        batch.update(centreAssignRef, {
          centreName: centreInfo.name,
          headUid: authUser.uid,
          headName: fullName.slice(0, 100),
          headEmail: cleanEmail,
          assignedBy: invite.invitedBy,
          updatedAt: serverTimestamp(),
        });
      } else {
        batch.set(centreAssignRef, {
          centreId: invite.centreId,
          centreName: centreInfo.name,
          headUid: authUser.uid,
          headName: fullName.slice(0, 100),
          headEmail: cleanEmail,
          assignedBy: invite.invitedBy,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    }

    try {
      await batch.commit();
      await logActivity({
        actorUid: authUser.uid,
        actorName: fullName,
        actorEmail: cleanEmail,
        actorRole: invite.role,
        centreId: invite.centreId,
        department: invite.department,
        action: 'STAFF_INVITE_CLAIMED',
        targetCollection: 'users',
        targetId: authUser.uid,
        details: `${fullName} activated ${invite.role} account at ${centreInfo.name} via Google Sign-In.`,
        locationVerified: true,
      }).catch(() => {});
      return userProfile as unknown as UserAccount;
    } catch (err) {
      // If another listener finished claiming simultaneously, return the created profile
      const fallback = await getUserProfile(authUser.uid).catch(() => null);
      if (fallback) return fallback;
      handleFirestoreError(err, OperationType.WRITE, `staff_invites/${inviteId}`);
    }
  })().finally(() => {
    inFlightInviteClaims.delete(authUser.uid);
  });

  inFlightInviteClaims.set(authUser.uid, run);
  return run;
}

export async function submitEmployeeReport(
  params: {
    reportDate: string;
    title: string;
    summary: string;
    tasksCompleted: number;
    studentsHandled: number;
    pendingIssues: string;
  },
  actor: UserAccount,
): Promise<void> {
  const reportId = `rep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const path = `employee_reports/${reportId}`;
  try {
    await setDoc(doc(db, 'employee_reports', reportId), {
      reportId,
      employeeUid: actor.uid,
      employeeName: actor.fullName.slice(0, 100),
      employeeEmail: actor.email.slice(0, 160),
      role: actor.role,
      centreId: actor.centreId,
      centreName: actor.centreName.slice(0, 120),
      department: actor.department,
      reportDate: params.reportDate.slice(0, 30),
      title: params.title.trim().slice(0, 160),
      summary: params.summary.trim().slice(0, 2000),
      tasksCompleted: Math.max(0, Math.min(10000, Math.round(params.tasksCompleted))),
      studentsHandled: Math.max(0, Math.min(10000, Math.round(params.studentsHandled))),
      pendingIssues: params.pendingIssues.trim().slice(0, 1000),
      status: 'Submitted',
      reviewerName: '',
      reviewerNote: '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    await createNotification({
      recipientUid: actor.uid,
      centreId: actor.centreId,
      title: `Work Report Submitted (${actor.department})`,
      message: `${actor.fullName} submitted "${params.title.trim()}" (${params.studentsHandled} students handled).`,
      type: 'info',
      read: false,
    }).catch(() => {});

    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: actor.centreId,
      department: actor.department,
      action: 'EMPLOYEE_REPORT_SUBMITTED',
      targetCollection: 'employee_reports',
      targetId: reportId,
      details: `Submitted report "${params.title.trim()}" (${params.tasksCompleted} tasks, ${params.studentsHandled} students).`,
      locationVerified: true,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function reviewEmployeeReport(
  reportId: string,
  status: EmployeeReportStatus,
  reviewerNote: string,
  actor: UserAccount,
  centreId: CentreId,
): Promise<void> {
  const path = `employee_reports/${reportId}`;
  try {
    await updateDoc(doc(db, 'employee_reports', reportId), {
      status,
      reviewerName: actor.fullName.slice(0, 100),
      reviewerNote: reviewerNote.trim().slice(0, 1000),
      updatedAt: serverTimestamp(),
    });
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId,
      department: actor.department,
      action: 'EMPLOYEE_REPORT_REVIEWED',
      targetCollection: 'employee_reports',
      targetId: reportId,
      details: `Marked report ${reportId} as ${status}.`,
      locationVerified: true,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function upsertHrRecord(
  record: Omit<HrRecord, 'createdBy' | 'createdAt' | 'updatedBy' | 'updatedAt'>,
  actor: UserAccount,
  locationVerified: boolean,
): Promise<void> {
  const path = `hr_records/${record.recordId}`;
  try {
    const ref = doc(db, 'hr_records', record.recordId);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      await updateDoc(ref, {
        ...record,
        updatedBy: actor.uid,
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(ref, {
        ...record,
        createdBy: actor.uid,
        createdAt: serverTimestamp(),
        updatedBy: actor.uid,
        updatedAt: serverTimestamp(),
      });
    }
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: record.centreId,
      department: 'hr',
      action: 'HR_RECORD_UPDATED',
      targetCollection: 'hr_records',
      targetId: record.recordId,
      details: `Updated HR record for ${record.staffName} (${record.recordMonth}): ${record.attendanceStatus} · Payroll ${record.payrollStatus}.`,
      locationVerified,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}


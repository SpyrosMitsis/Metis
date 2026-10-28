package com.workoutmaker.app.strength

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class SessionSnapshotFileTest {
    @get:Rule val folder = TemporaryFolder()

    @Test fun olderWriteCannotReplaceBackgroundSave() {
        val file = File(folder.root, "session.json")
        val store = SessionSnapshotFile(file)
        val old = store.nextRevision()
        val latest = store.nextRevision()
        store.write(latest, "new edits")
        store.write(old, "old edits")
        assertEquals("new edits", file.readText())
    }

    @Test fun pendingWriteCannotResurrectDiscardedSession() {
        val file = File(folder.root, "session.json")
        val store = SessionSnapshotFile(file)
        val old = store.nextRevision()
        store.write(old, "session")
        store.write(store.nextRevision(), null)
        store.write(old, "session")
        assertFalse(file.exists())
        store.write(store.nextRevision(), "next session")
        assertEquals("next session", file.readText())
    }
}

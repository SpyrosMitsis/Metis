package com.workoutmaker.app.strength

import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/** Serializes disk writes and rejects snapshots superseded by a save or discard. */
internal class SessionSnapshotFile(private val file: File) {
    private var revision = 0L

    @Synchronized
    fun nextRevision(): Long = ++revision

    @Synchronized
    fun write(expectedRevision: Long, contents: String?) {
        if (expectedRevision != revision) return
        if (contents == null) {
            Files.deleteIfExists(file.toPath())
            return
        }
        val tmp = File(file.parentFile, "${file.name}.tmp")
        try {
            tmp.writeText(contents)
            Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING)
        } finally {
            tmp.delete()
        }
    }
}
